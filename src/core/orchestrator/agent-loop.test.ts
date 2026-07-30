import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LlmChatResult } from "@/core/llm";

/**
 * Тесты агентного цикла на моках модели и базы.
 *
 * Здесь проверяется не «вызвался ли инструмент», а поведение цикла в тех
 * ситуациях, где он может навредить: модель выдумала инструмент, прислала
 * мусор в аргументах, инструмент упал, модель зациклилась, действие опасное.
 * В Фазе 0 отсутствие ровно таких тестов вокруг каскада шлюзов стоило
 * работающего механизма отказоустойчивости — повторять не хочется.
 */

const llmChatMock = vi.fn();

const notificationCreate = vi.fn(async (..._a: unknown[]) => ({ id: "notif_1" }));
const actionCreate = vi.fn(async (..._a: unknown[]) => ({ id: "action_1" }));
const runUpdate = vi.fn(async (..._a: unknown[]) => ({}));
const messageFindMany = vi.fn(
  async (..._a: unknown[]) => [] as Array<{ role: string; content: string }>,
);

vi.mock("@/core/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/llm")>();
  return { ...actual, llmChat: (...args: unknown[]) => llmChatMock(...args) };
});

vi.mock("@/core/db", () => ({
  prisma: {
    agentRun: {
      create: vi.fn(async (..._a: unknown[]) => ({ id: "run_1" })),
      update: (...a: unknown[]) => runUpdate(...a),
    },
    agentAction: { create: (...a: unknown[]) => actionCreate(...a) },
    notification: { create: (...a: unknown[]) => notificationCreate(...a) },
    message: { findMany: (...a: unknown[]) => messageFindMany(...a) },
  },
}));

const { runAgent } = await import("./agent-loop");
const { ToolRegistry } = await import("./tool-registry");
type AgentTool = import("./types").AgentTool;

function reply(text: string, toolCalls: LlmChatResult["toolCalls"] = []): LlmChatResult {
  return {
    text,
    toolCalls,
    rawToolCalls: toolCalls.length
      ? toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }))
      : null,
    gateway: "polza",
    model: "test-model",
    inputTokens: 10,
    outputTokens: 5,
    latencyMs: 1,
  };
}

function call(name: string, args: unknown, id = "c1") {
  return { id, name, arguments: JSON.stringify(args) };
}

function agentWith(tools: AgentTool[]) {
  return {
    key: "secretary",
    registry: new ToolRegistry().registerAll(tools),
    buildSystemPrompt: () => "системный промпт",
  };
}

const RUN = {
  agentKey: "secretary",
  conversationId: "conv_1",
  channel: "TELEGRAM" as const,
  trigger: "TELEGRAM" as const,
  userText: "привет",
};

beforeEach(() => {
  llmChatMock.mockReset();
  notificationCreate.mockClear();
  actionCreate.mockClear();
  runUpdate.mockClear();
  messageFindMany.mockClear();
  messageFindMany.mockResolvedValue([]);
});

afterEach(() => vi.clearAllMocks());

describe("простой ответ", () => {
  it("текст без вызовов возвращается сразу", async () => {
    llmChatMock.mockResolvedValueOnce(reply("Привет! Чем помочь?"));
    const res = await runAgent(agentWith([]), RUN);

    expect(res.text).toBe("Привет! Чем помочь?");
    expect(res.toolCallCount).toBe(0);
    expect(llmChatMock).toHaveBeenCalledTimes(1);
  });
});

describe("вызов инструмента", () => {
  const created: string[] = [];
  const createTask: AgentTool = {
    name: "create_task",
    description: "создать задачу",
    schema: z.object({ title: z.string().min(1) }),
    async execute(args) {
      created.push((args as { title: string }).title);
      return { ok: true, message: "Задача создана", data: { id: "t1" } };
    },
  };

  beforeEach(() => (created.length = 0));

  it("исполняет инструмент и возвращает его результат модели", async () => {
    llmChatMock
      .mockResolvedValueOnce(reply("", [call("create_task", { title: "позвонить в банк" })]))
      .mockResolvedValueOnce(reply("Записала."));

    const res = await runAgent(agentWith([createTask]), RUN);

    expect(created).toEqual(["позвонить в банк"]);
    expect(res.text).toBe("Записала.");
    expect(res.toolCallCount).toBe(1);

    // Второй запрос к модели обязан содержать и её собственный вызов, и ответ
    // инструмента с тем же tool_call_id — иначе провайдер вернёт 400.
    const second = llmChatMock.mock.calls[1]?.[0] as unknown as {
      messages: Array<Record<string, unknown>>;
    };
    const toolMsg = second.messages.find((m) => m.role === "tool");
    expect(toolMsg?.tool_call_id).toBe("c1");
    expect(second.messages.some((m) => m.role === "assistant" && m.tool_calls)).toBe(true);
  });

  it("исполняет несколько вызовов из одного ответа", async () => {
    llmChatMock
      .mockResolvedValueOnce(
        reply("", [
          call("create_task", { title: "первая" }, "c1"),
          call("create_task", { title: "вторая" }, "c2"),
        ]),
      )
      .mockResolvedValueOnce(reply("Обе записала."));

    const res = await runAgent(agentWith([createTask]), RUN);
    expect(created).toEqual(["первая", "вторая"]);
    expect(res.toolCallCount).toBe(2);
  });
});

describe("цикл переживает плохие ответы модели", () => {
  const ok: AgentTool = {
    name: "list_tasks",
    description: "список задач",
    schema: z.object({}),
    async execute() {
      return { ok: true, message: "задач нет" };
    },
  };

  it("выдуманный инструмент не роняет диалог, модель получает список настоящих", async () => {
    llmChatMock
      .mockResolvedValueOnce(reply("", [call("сделай_магию", {})]))
      .mockResolvedValueOnce(reply("Так не умею, но вот что могу…"));

    const res = await runAgent(agentWith([ok]), RUN);

    expect(res.text).toBe("Так не умею, но вот что могу…");
    const second = llmChatMock.mock.calls[1]?.[0] as unknown as {
      messages: Array<Record<string, unknown>>;
    };
    const toolMsg = second.messages.find((m) => m.role === "tool");
    expect(String(toolMsg?.content)).toContain("list_tasks");
  });

  it("неверные аргументы возвращаются модели как ошибка проверки", async () => {
    const strict: AgentTool = {
      name: "create_task",
      description: "создать задачу",
      schema: z.object({ title: z.string().min(1) }),
      async execute() {
        throw new Error("не должно быть вызвано");
      },
    };
    llmChatMock
      .mockResolvedValueOnce(reply("", [call("create_task", { title: "" })]))
      .mockResolvedValueOnce(reply("Уточни, что записать?"));

    const res = await runAgent(agentWith([strict]), RUN);

    expect(res.text).toBe("Уточни, что записать?");
    const second = llmChatMock.mock.calls[1]?.[0] as unknown as {
      messages: Array<Record<string, unknown>>;
    };
    expect(String(second.messages.find((m) => m.role === "tool")?.content)).toContain("title");
  });

  it("упавший инструмент не роняет диалог", async () => {
    const broken: AgentTool = {
      name: "list_tasks",
      description: "список задач",
      schema: z.object({}),
      async execute() {
        throw new Error("база недоступна");
      },
    };
    llmChatMock
      .mockResolvedValueOnce(reply("", [call("list_tasks", {})]))
      .mockResolvedValueOnce(reply("Не смогла посмотреть задачи."));

    const res = await runAgent(agentWith([broken]), RUN);
    expect(res.text).toBe("Не смогла посмотреть задачи.");
  });

  it("зацикленная модель обрывается и получает понятный ответ, а не тишину", async () => {
    llmChatMock.mockResolvedValue(reply("", [call("list_tasks", {})]));

    const res = await runAgent(agentWith([ok]), RUN);

    expect(res.text).toMatch(/шаг/i);
    // Ограничение обязано быть жёстким: иначе каждая итерация — деньги.
    expect(llmChatMock.mock.calls.length).toBeLessThanOrEqual(8);
    expect(runUpdate).toHaveBeenCalled();
  });
});

describe("опасные действия", () => {
  const send: AgentTool = {
    name: "send_message",
    description: "отправить сообщение клиенту",
    schema: z.object({ to: z.string(), text: z.string() }),
    dangerous: true,
    sensitiveArgs: ["text"],
    async execute() {
      throw new Error("опасный инструмент не должен исполняться сам");
    },
  };

  it("не исполняются, а уходят на подтверждение владельцу", async () => {
    llmChatMock
      .mockResolvedValueOnce(reply("", [call("send_message", { to: "клиент", text: "привет" })]))
      .mockResolvedValueOnce(reply("Черновик готов, жду подтверждения."));

    const res = await runAgent(agentWith([send]), RUN);

    expect(res.pendingApprovals).toEqual(["send_message"]);
    expect(notificationCreate).toHaveBeenCalledTimes(1);

    const notif = notificationCreate.mock.calls[0]?.[0] as unknown as { data: { type: string } };
    expect(notif.data.type).toBe("APPROVAL_REQUIRED");
  });

  it("чувствительные аргументы не попадают в журнал", async () => {
    llmChatMock
      .mockResolvedValueOnce(reply("", [call("send_message", { to: "клиент", text: "личное" })]))
      .mockResolvedValueOnce(reply("Готово."));

    await runAgent(agentWith([send]), RUN);

    const action = actionCreate.mock.calls[0]?.[0] as unknown as {
      data: { input: Record<string, unknown> };
    };
    expect(action.data.input.text).toBe("***");
    expect(action.data.input.to).toBe("клиент");
  });
});

describe("история диалога", () => {
  it("сообщения инструментов из прошлых запусков в контекст не идут", async () => {
    // Их tool_call_id ссылается на вызовы, которых в текущем запросе нет —
    // провайдер отверг бы такой запрос целиком.
    messageFindMany.mockResolvedValue([
      { role: "ASSISTANT", content: "ранее ответила" },
      { role: "USER", content: "ранее спросил" },
    ]);
    llmChatMock.mockResolvedValueOnce(reply("ок"));

    await runAgent(agentWith([]), RUN);

    const where = (messageFindMany.mock.calls[0]?.[0] ?? {}) as {
      where?: { role?: { in?: string[] } };
    };
    expect(where.where?.role?.in).toEqual(["USER", "ASSISTANT"]);

    const sent = llmChatMock.mock.calls[0]?.[0] as unknown as { messages: Array<{ role: string }> };
    expect(sent.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("вопрос владельца попадает в контекст, даже если его забыли сохранить", async () => {
    // Иначе агент отвечает, не видя вопроса, — получается связный ответ не на то.
    messageFindMany.mockResolvedValue([]);
    llmChatMock.mockResolvedValueOnce(reply("ок"));

    await runAgent(agentWith([]), { ...RUN, userText: "напомни про банк" });

    const sent = llmChatMock.mock.calls[0]?.[0] as unknown as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(sent.messages.at(-1)).toEqual({ role: "user", content: "напомни про банк" });
  });

  it("не дублирует вопрос, если он уже сохранён в истории", async () => {
    messageFindMany.mockResolvedValue([{ role: "USER", content: "напомни про банк" }]);
    llmChatMock.mockResolvedValueOnce(reply("ок"));

    await runAgent(agentWith([]), { ...RUN, userText: "напомни про банк" });

    const sent = llmChatMock.mock.calls[0]?.[0] as unknown as { messages: Array<{ role: string }> };
    expect(sent.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });
});
