/**
 * Обработка сообщения владельца в Telegram.
 *
 * Фаза 0 — «эхо-агент»: история + системный промпт + один вызов модели, без
 * инструментов и памяти (они появятся в Фазе 1 вместе с рантаймом агента).
 * Здесь важна не функциональность, а каркас: любая ветка заканчивается
 * ОТПРАВЛЕННЫМ сообщением. Молчание бота владелец читает как «сломался», и
 * дальше диагностика идёт по логам вслепую.
 */

import { readFileSync } from "node:fs";
import { Channel, MessageRole } from "@prisma/client";
import { prisma } from "@/core/db";
import { LlmUnavailableError, llmChat, llmConfigured, type LlmMessage } from "@/core/llm";
import { runAgent } from "@/core/orchestrator";
import { secretaryAgent } from "@/modules/secretary/agent";
import { handleCallback } from "@/modules/secretary/handle-callback";
import { logError, logInfo, logWarn, startTimer } from "@/core/observability/logger";
import { formatLocal } from "@/core/shared/time";
import { tgSendChatAction, tgSendMessage } from "./bot";
import { parseTelegramUpdate, unsupportedReply, type TelegramUpdate } from "./update";

const AGENT_KEY = "secretary";
/** Сколько последних сообщений подкладываем в контекст. */
const HISTORY_LIMIT = 20;

const GREETING = [
  "Привет! Я Ася — твой личный секретарь в Business OS.",
  "",
  "Сейчас умею немного: отвечаю на вопросы и помню наш диалог в этом чате.",
  "Скоро научусь вести задачи и напоминания, собирать утренний бриф, считать деньги и следить за продажами.",
  "",
  "Команды: /ping — проверить, что я жива и какая сборка сейчас в проде.",
  "Просто напиши, что нужно, — обычным текстом.",
].join("\n");

const LLM_NOT_CONFIGURED =
  "ИИ-шлюзы ещё не настроены — я не могу ответить осмысленно. Нужно задать POLZA_API_KEY или PROXYAPI_API_KEY в переменных окружения.";

const GENERIC_ERROR =
  "Не смогла обработать сообщение — что-то сломалось на моей стороне. Попробуй ещё раз через минуту.";

/**
 * SHA сборки читаем один раз при старте модуля: файл кладёт Docker-сборка,
 * дёргать диск на каждый /ping незачем.
 */
const BUILD_SHA: string = (() => {
  const fromEnv = process.env.APP_GIT_SHA?.trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(".build-sha", "utf8").trim() || "неизвестно";
  } catch {
    return "неизвестно";
  }
})();

export function systemPrompt(now: Date = new Date()): string {
  return [
    "Ты — Ася, личный секретарь-заместитель владельца небольшого бизнеса.",
    "Пиши по-русски, на «ты», тепло и по-деловому. Коротко: до 6 предложений, без воды и без списков там, где хватит фразы.",
    "Честность важнее приятности: не знаешь — скажи прямо, не выдумывай цифры и факты.",
    "У тебя пока нет ни инструментов, ни долговременной памяти: ты не можешь создавать задачи, напоминания и смотреть финансы. Если просят такое — честно скажи, что это появится в ближайшем обновлении, и предложи записать это текстом здесь же.",
    "Ты не врач и не терапевт: диагнозов не ставишь, при серьёзных переживаниях бережно советуешь специалиста.",
    `Сейчас ${formatLocal(now)} (Москва).`,
  ].join("\n");
}

interface ChatContext {
  conversationId: string | null;
  history: LlmMessage[];
}

/**
 * История диалога. Любая ошибка БД деградирует до пустой истории, но не
 * отменяет ответ: без Neon бот всё ещё полезен, просто забывчив.
 */
async function loadContext(): Promise<ChatContext> {
  try {
    const existing = await prisma.conversation.findFirst({
      where: { agentKey: AGENT_KEY, channel: Channel.TELEGRAM, archived: false },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });

    const conversation =
      existing ??
      (await prisma.conversation.create({
        data: { agentKey: AGENT_KEY, channel: Channel.TELEGRAM, title: "Telegram" },
        select: { id: true },
      }));

    const rows = await prisma.message.findMany({
      where: {
        conversationId: conversation.id,
        // TOOL-сообщения без парного tool_call_id ломают запрос к
        // OpenAI-совместимому шлюзу; в Фазе 0 их всё равно никто не пишет.
        role: { in: [MessageRole.USER, MessageRole.ASSISTANT] },
      },
      orderBy: { createdAt: "desc" },
      take: HISTORY_LIMIT,
      select: { role: true, content: true },
    });

    const history: LlmMessage[] = rows
      .reverse()
      .map((row) => ({
        role: row.role === MessageRole.USER ? ("user" as const) : ("assistant" as const),
        content: row.content,
      }));

    return { conversationId: conversation.id, history };
  } catch (error) {
    logWarn("telegram.history_unavailable", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return { conversationId: null, history: [] };
  }
}

async function saveMessage(
  conversationId: string | null,
  role: MessageRole,
  content: string,
  tokens?: number,
): Promise<void> {
  if (!conversationId) return;
  try {
    await prisma.message.create({ data: { conversationId, role, content, tokens: tokens ?? null } });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
  } catch (error) {
    logWarn("telegram.history_write_failed", {
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}

async function replyWithLlm(chatId: number, text: string): Promise<void> {
  if (!llmConfigured()) {
    await tgSendMessage(chatId, LLM_NOT_CONFIGURED);
    return;
  }

  await tgSendChatAction(chatId, "typing");

  const context = await loadContext();
  // Сообщение владельца пишем ДО вызова модели: если генерация упадёт, вопрос
  // всё равно останется в истории и не потеряется при повторе.
  await saveMessage(context.conversationId, MessageRole.USER, text);

  const done = startTimer();
  try {
    // Без диалога в базе агентный цикл работать не может (ему негде вести
    // историю и журнал), поэтому при недоступной базе отвечаем простым
    // вызовом модели — без инструментов, но и без молчания.
    if (!context.conversationId) {
      const reply = await replyWithoutTools(text, context.history);
      await tgSendMessage(chatId, reply);
      logWarn("telegram.reply_without_tools", { ms: done() });
      return;
    }

    const result = await runAgent(secretaryAgent, {
      agentKey: secretaryAgent.key,
      conversationId: context.conversationId,
      channel: "TELEGRAM",
      trigger: "TELEGRAM",
      userText: text,
    });

    const reply = result.text.trim() || "Не нашлась с ответом — переформулируй, пожалуйста.";
    await saveMessage(context.conversationId, MessageRole.ASSISTANT, reply);
    await tgSendMessage(chatId, reply);

    logInfo("telegram.reply_sent", {
      ms: done(),
      runId: result.runId,
      toolCalls: result.toolCallCount,
      gateway: result.gateway,
      model: result.model,
      chars: reply.length,
    });
  } catch (error) {
    // Ошибку каскада показываем владельцу как есть: её текст уже русский и
    // объясняет причину («шлюзы недоступны», «дневной бюджет исчерпан»).
    const message = error instanceof LlmUnavailableError ? error.message : GENERIC_ERROR;
    logError("telegram.reply_failed", {
      ms: done(),
      error: error instanceof Error ? error.message : "unknown",
    });
    await tgSendMessage(chatId, message);
  }
}

/** Команды обрабатываются без модели: ответ должен приходить мгновенно и всегда. */
async function handleCommand(chatId: number, text: string): Promise<boolean> {
  const command = text.split(/\s+/, 1)[0]?.toLowerCase().split("@")[0];

  if (command === "/start" || command === "/help") {
    await tgSendMessage(chatId, GREETING);
    return true;
  }

  if (command === "/ping") {
    await tgSendMessage(chatId, `Понг. Сборка: ${BUILD_SHA}`);
    return true;
  }

  return false;
}

/**
 * Полная обработка апдейта. Вызывается ПОСЛЕ того, как вебхук ответил 200,
 * поэтому наружу не бросает: необработанное исключение в фоновой задаче
 * роняет процесс Node целиком.
 */
export async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const parsed = parseTelegramUpdate(update);

  if (parsed.kind === "ignored") {
    logInfo("telegram.update_ignored", { reason: parsed.reason });
    return;
  }

  try {
    if (parsed.kind === "unsupported") {
      logInfo("telegram.update_unsupported", { media: parsed.media });
      await tgSendMessage(parsed.chatId, unsupportedReply(parsed.media));
      return;
    }

    if (parsed.kind === "callback") {
      await handleCallback({
        callbackId: parsed.callbackId,
        chatId: parsed.chatId,
        messageId: parsed.messageId,
        data: parsed.data,
      });
      return;
    }

    if (parsed.text.startsWith("/") && (await handleCommand(parsed.chatId, parsed.text))) return;

    await replyWithLlm(parsed.chatId, parsed.text);
  } catch (error) {
    logError("telegram.handle_failed", {
      error: error instanceof Error ? error.message : "unknown",
    });
    await tgSendMessage(parsed.chatId, GENERIC_ERROR).catch(() => {
      // Если не доходит даже сообщение об ошибке — канал лёг целиком,
      // сделать уже нечего, факт зафиксирован логом выше.
    });
  }
}

/**
 * Ответ без инструментов — запасной путь на случай недоступной базы.
 * Секретарь в этом режиме не умеет заводить задачи и напоминания, но
 * поддержать разговор может, и это лучше, чем молчание.
 */
async function replyWithoutTools(text: string, history: LlmMessage[]): Promise<string> {
  const result = await llmChat({
    feature: "telegram.chat_degraded",
    preset: "smart",
    messages: [
      { role: "system", content: systemPrompt() },
      ...history,
      { role: "user", content: text },
    ],
  });
  return result.text.trim() || "Не нашлась с ответом — переформулируй, пожалуйста.";
}
