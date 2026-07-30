import { prisma } from "@/core/db";
import { LlmUnavailableError, llmChat, type LlmMessage } from "@/core/llm";
import { logError, logInfo, logWarn } from "@/core/observability/logger";
import { maskArgs, parseToolArgs, type ToolRegistry } from "./tool-registry";
import type { AgentRunOptions, AgentRunResult, AgentTool, ToolContext, ToolResult } from "./types";

/**
 * Агентный цикл: один на все отделы.
 *
 * Модель отвечает либо текстом (тогда мы закончили), либо вызовами
 * инструментов — их надо исполнить, вернуть результаты и спросить снова.
 * Всё остальное здесь — про то, чтобы цикл не съел деньги и не завис.
 */

/**
 * Потолок итераций. Модель умеет зацикливаться: вызвать инструмент, получить
 * не тот ответ, вызвать его же снова — и так пока хватает бюджета. Восьми
 * шагов достаточно для любого разумного сценария («посмотреть задачи, создать
 * ещё одну, поставить напоминание»), а неразумный обрывается за понятную цену.
 */
const MAX_ITERATIONS = 8;

/** Сколько последних сообщений диалога кладём в контекст. */
const HISTORY_LIMIT = 20;

export interface AgentDefinition {
  key: string;
  registry: ToolRegistry;
  /**
   * Системный промпт собирается на каждый запуск: в нём есть и «сегодня», и
   * подобранные под вопрос факты из памяти — поэтому сюда передаётся текст
   * обращения владельца.
   */
  buildSystemPrompt(ctx: { now: Date; userText: string }): Promise<string> | string;
}

export async function runAgent(
  agent: AgentDefinition,
  opts: AgentRunOptions,
): Promise<AgentRunResult> {
  const now = opts.now ?? new Date();

  const run = await prisma.agentRun.create({
    data: {
      agentKey: agent.key,
      conversationId: opts.conversationId,
      trigger: opts.trigger,
      status: "RUNNING",
    },
    select: { id: true },
  });

  const ctx: ToolContext = { runId: run.id, channel: opts.channel, now };
  const pendingApprovals: string[] = [];
  let seq = 0;
  let toolCallCount = 0;
  let gateway: string | undefined;
  let model: string | undefined;

  try {
    const userText = opts.userText.trim();
    const history = await loadHistory(opts.conversationId);

    // Вопрос владельца обычно уже лежит в истории — вызывающий код сохраняет
    // его до запуска агента. Но полагаться на это молча нельзя: если он этого
    // не сделал (или база не успела), агент будет отвечать, не видя вопроса,
    // и получится связный ответ не на то. Проверяем и дописываем сами.
    const last = history[history.length - 1];
    if (userText.length > 0 && !(last?.role === "user" && last.content.trim() === userText)) {
      history.push({ role: "user", content: userText });
    }

    const messages: LlmMessage[] = [
      { role: "system", content: await agent.buildSystemPrompt({ now, userText }) },
      ...history,
    ];

    const tools = agent.registry.definitions();

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      const result = await llmChat({
        feature: `${agent.key}.chat`,
        messages,
        preset: "smart",
        tools: tools.length > 0 ? tools : undefined,
        runId: run.id,
        signal: opts.signal,
      });
      gateway = result.gateway;
      model = result.model;

      if (result.toolCalls.length === 0) {
        await finishRun(run.id, "OK", iteration);
        return {
          runId: run.id,
          text: result.text,
          toolCallCount,
          pendingApprovals,
          gateway,
          model,
        };
      }

      // Ответ модели с вызовами обязан вернуться в историю ЦЕЛИКОМ: провайдер
      // отвергает результат инструмента, которому не предшествует вызов.
      messages.push({
        role: "assistant",
        content: result.text,
        tool_calls: result.rawToolCalls ?? undefined,
      });

      for (const call of result.toolCalls) {
        toolCallCount += 1;
        seq += 1;
        const outcome = await executeCall({
          agent,
          call,
          ctx,
          seq,
          pendingApprovals,
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: outcome.message,
        });
      }
    }

    // Итерации кончились, а модель всё ещё зовёт инструменты. Отвечать
    // молчанием нельзя — владелец ждёт ответа в чате.
    logWarn("agent.iterations_exhausted", { agentKey: agent.key, runId: run.id });
    await finishRun(run.id, "ERROR", MAX_ITERATIONS, "исчерпан лимит итераций");
    return {
      runId: run.id,
      text:
        "Не смог довести задачу до конца за отведённые шаги. Опиши, пожалуйста, " +
        "что нужно сделать, чуть конкретнее — так я справлюсь быстрее.",
      toolCallCount,
      pendingApprovals,
      gateway,
      model,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await finishRun(run.id, "ERROR", seq, message);
    logError("agent.run_failed", { agentKey: agent.key, runId: run.id, error: message });

    // Текст LlmUnavailableError уже написан для владельца (он объясняет,
    // исчерпан ли лимит расходов или молчат шлюзы) — отдаём как есть.
    if (e instanceof LlmUnavailableError) throw e;
    throw new Error(`Сбой агента: ${message}`);
  }
}

async function executeCall(params: {
  agent: AgentDefinition;
  call: { id: string; name: string; arguments: string };
  ctx: ToolContext;
  seq: number;
  pendingApprovals: string[];
}): Promise<ToolResult> {
  const { agent, call, ctx, seq, pendingApprovals } = params;
  const startedAt = Date.now();

  const tool = agent.registry.get(call.name);
  if (!tool) {
    // Модель выдумала инструмент. Возвращаем ей список настоящих — со второй
    // попытки она обычно выбирает верный.
    const known = agent.registry.names().join(", ") || "нет доступных";
    const message = `Инструмента «${call.name}» не существует. Доступны: ${known}`;
    await recordAction({ runId: ctx.runId, seq, toolName: call.name, input: {}, status: "ERROR", message, startedAt });
    return { ok: false, message };
  }

  const parsed = parseToolArgs(tool.schema, call.arguments);
  if (!parsed.ok) {
    const message = `Вызов «${call.name}» отклонён: ${parsed.error}`;
    await recordAction({
      runId: ctx.runId,
      seq,
      toolName: call.name,
      input: { raw: call.arguments.slice(0, 500) },
      status: "ERROR",
      message,
      startedAt,
    });
    return { ok: false, message };
  }

  const maskedInput = maskArgs(parsed.value, tool.sensitiveArgs);

  if (isDangerous(tool, parsed.value)) {
    return requestApproval({ tool, ctx, seq, args: parsed.value, maskedInput, startedAt, pendingApprovals });
  }

  try {
    const result = await tool.execute(parsed.value, ctx);
    await recordAction({
      runId: ctx.runId,
      seq,
      toolName: tool.name,
      input: maskedInput,
      status: result.ok ? "OK" : "ERROR",
      message: result.message,
      data: result.data,
      startedAt,
    });
    return result;
  } catch (e) {
    // Падение инструмента не должно ронять весь диалог: модель получает
    // ошибку как результат и может объяснить её владельцу или попробовать иначе.
    const error = e instanceof Error ? e.message : String(e);
    logError("agent.tool_failed", { tool: tool.name, runId: ctx.runId, error });
    const message = `Инструмент «${tool.name}» завершился ошибкой: ${error}`;
    await recordAction({
      runId: ctx.runId,
      seq,
      toolName: tool.name,
      input: maskedInput,
      status: "ERROR",
      message,
      startedAt,
    });
    return { ok: false, message };
  }
}

/**
 * Нужно ли подтверждение владельца.
 *
 * Предикат считаем строго после валидации аргументов — иначе он разбирал бы
 * то, что прислала модель, а она присылает и число строкой, и вовсе не то поле.
 * Падение предиката трактуем как «опасно»: если решить не удалось, спросить
 * владельца дешевле, чем выполнить молча.
 */
export function isDangerous(tool: AgentTool, args: unknown): boolean {
  if (typeof tool.dangerous !== "function") return tool.dangerous === true;
  try {
    return tool.dangerous(args) === true;
  } catch (e) {
    logWarn("agent.danger_check_failed", {
      tool: tool.name,
      error: e instanceof Error ? e.message : String(e),
    });
    return true;
  }
}

/**
 * Опасное действие: вместо исполнения создаём уведомление с подтверждением.
 *
 * Модели свойственно быть услужливой, и «отправить клиенту сообщение» она
 * предложит с той же лёгкостью, что и «создать задачу». Разница в том, что
 * второе владелец отменит одним нажатием, а первое уже прочитал посторонний
 * человек.
 */
async function requestApproval(params: {
  tool: AgentTool;
  ctx: ToolContext;
  seq: number;
  args: unknown;
  maskedInput: Record<string, unknown>;
  startedAt: number;
  pendingApprovals: string[];
}): Promise<ToolResult> {
  const { tool, ctx, seq, args, maskedInput, startedAt, pendingApprovals } = params;

  const action = await prisma.agentAction.create({
    data: {
      runId: ctx.runId,
      seq,
      toolName: tool.name,
      input: maskedInput as never,
      status: "PENDING_APPROVAL",
      durationMs: Date.now() - startedAt,
    },
    select: { id: true },
  });

  await prisma.notification.create({
    data: {
      type: "APPROVAL_REQUIRED",
      module: "secretary",
      title: `Подтвердите действие: ${tool.name}`,
      body: tool.description,
      // Полные аргументы нужны, чтобы исполнить действие после подтверждения;
      // в journal они попали замаскированными, здесь — как есть.
      payload: { actionId: action.id, toolName: tool.name, args } as never,
    },
  });

  pendingApprovals.push(tool.name);
  logInfo("agent.approval_requested", { tool: tool.name, runId: ctx.runId });

  return {
    ok: true,
    message:
      `Действие «${tool.name}» подготовлено и ждёт подтверждения владельца — ` +
      "самостоятельно оно не выполнено. Скажи об этом в ответе.",
  };
}

async function recordAction(params: {
  runId: string;
  seq: number;
  toolName: string;
  input: Record<string, unknown>;
  status: "OK" | "ERROR";
  message: string;
  data?: Record<string, unknown>;
  startedAt: number;
}): Promise<void> {
  try {
    await prisma.agentAction.create({
      data: {
        runId: params.runId,
        seq: params.seq,
        toolName: params.toolName,
        input: params.input as never,
        output: { message: params.message, ...(params.data ?? {}) } as never,
        status: params.status,
        durationMs: Date.now() - params.startedAt,
      },
    });
  } catch (e) {
    // Журнал важен, но не важнее ответа владельцу.
    logError("agent.action_write_failed", {
      runId: params.runId,
      tool: params.toolName,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

async function finishRun(
  runId: string,
  status: "OK" | "ERROR",
  iterations: number,
  error?: string,
): Promise<void> {
  try {
    await prisma.agentRun.update({
      where: { id: runId },
      data: { status, iterations, error: error ?? null, finishedAt: new Date() },
    });
  } catch (e) {
    logError("agent.run_close_failed", {
      runId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * История диалога для контекста.
 *
 * Берём последние сообщения и разворачиваем в хронологический порядок.
 * Сообщения роли TOOL пропускаем: их `tool_call_id` относится к вызовам из
 * прошлых запусков, которых в текущем контексте нет, и провайдер отвергнет
 * такой запрос целиком.
 */
async function loadHistory(conversationId: string): Promise<LlmMessage[]> {
  const rows = await prisma.message.findMany({
    where: { conversationId, role: { in: ["USER", "ASSISTANT"] } },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
    select: { role: true, content: true },
  });

  return rows
    .reverse()
    .map((m) => ({
      role: m.role === "USER" ? ("user" as const) : ("assistant" as const),
      content: m.content,
    }))
    .filter((m) => m.content.trim().length > 0);
}
