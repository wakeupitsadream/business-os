/**
 * Клиент Telegram Bot API.
 *
 * Весь трафик идёт через реверс-прокси (Cloudflare Worker, env
 * TELEGRAM_API_BASE): прямой api.telegram.org из Timeweb заблокирован.
 * Входящие вебхуки — тоже через Worker (TELEGRAM_WEBHOOK_BASE): прямая
 * доставка Telegram → РФ-хостинг фильтруется на входе и ретраится минутами
 * (инцидент Agentus 10.07.2026: ответы приходили через 10+ минут при быстрой
 * генерации).
 */

import { isTest, optionalEnv } from "@/core/env";
import { logError, logInfo, logWarn } from "@/core/observability/logger";
import { TELEGRAM_TEXT_LIMIT, splitTextForMessenger } from "./split-text";

const SEND_ATTEMPTS = 3;
const SEND_TIMEOUT_MS = 15_000;
const ACTION_TIMEOUT_MS = 5_000;
/** Порог «медленной» отправки: предвестник таймаутов и жалоб «бот тупит». */
const SLOW_SEND_MS = 3_000;
const RETRY_BASE_MS = isTest ? 5 : 1_000;
/** Telegram может попросить подождать минуты — столько ждать нельзя. */
const MAX_RETRY_AFTER_SEC = 30;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function withScheme(raw: string): string {
  const value = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return value.replace(/\/+$/, "");
}

/**
 * База Bot API. Схема подставляется автоматически: панель Timeweb при
 * сохранении env однажды обрезала «https://», и весь канал упал с
 * «Failed to parse URL» — голый хост не должен убивать Telegram.
 */
export function tgBase(): string {
  const raw = optionalEnv("TELEGRAM_API_BASE");
  return raw ? withScheme(raw) : "https://api.telegram.org";
}

/** Публичная база для setWebhook: Worker принимает апдейт и форвардит на прод. */
export function telegramWebhookBase(fallbackOrigin: string): string {
  const raw = optionalEnv("TELEGRAM_WEBHOOK_BASE");
  return raw ? withScheme(raw) : withScheme(fallbackOrigin);
}

export function tgConfigured(): boolean {
  return Boolean(optionalEnv("TELEGRAM_BOT_TOKEN"));
}

/** Единственный chat_id, который бот обслуживает: это личный бот одного человека. */
export function ownerChatId(): number | null {
  const raw = optionalEnv("TELEGRAM_OWNER_CHAT_ID");
  if (!raw) return null;
  const id = Number.parseInt(raw, 10);
  return Number.isFinite(id) ? id : null;
}

export interface TgButton {
  text: string;
  callbackData?: string;
  url?: string;
}

export interface TgSendOptions {
  buttons?: TgButton[][];
  parseMode?: "Markdown" | "HTML";
}

interface TgApiResponse {
  ok: boolean;
  status: number;
  data: unknown;
  description?: string;
  retryAfterSec?: number;
}

/**
 * Таймаут ≠ «запрос не ушёл»: при медленном канале сообщение чаще всего уже
 * доставлено, потерян только ответ. Слепой повтор в этом случае дублирует
 * сообщение владельцу (инцидент Agentus 11.07.2026 — тройные ответы).
 */
function isDeliveryTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/** Одно обращение к методу Bot API без ретраев. Бросает при сетевой ошибке. */
async function callApi(
  method: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<TgApiResponse> {
  const token = optionalEnv("TELEGRAM_BOT_TOKEN");
  if (!token) return { ok: false, status: 0, data: null, description: "нет TELEGRAM_BOT_TOKEN" };

  const res = await fetch(`${tgBase()}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const data = (await res.json().catch(() => null)) as {
    ok?: boolean;
    description?: string;
    parameters?: { retry_after?: number };
  } | null;

  return {
    ok: res.ok && data?.ok !== false,
    status: res.status,
    data,
    description: data?.description,
    retryAfterSec: data?.parameters?.retry_after,
  };
}

/**
 * Вызов произвольного метода Bot API для диагностических роутов
 * (setWebhook/getWebhookInfo). Сетевые ошибки не бросает.
 */
export async function tgApi(
  method: string,
  payload: Record<string, unknown> = {},
  timeoutMs = SEND_TIMEOUT_MS,
): Promise<TgApiResponse> {
  try {
    return await callApi(method, payload, timeoutMs);
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      description: error instanceof Error ? error.message : "сетевая ошибка",
    };
  }
}

function inlineKeyboard(buttons: TgButton[][]): Record<string, unknown> {
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((button) =>
        button.url
          ? { text: button.text, url: button.url }
          : { text: button.text, callback_data: button.callbackData ?? button.text },
      ),
    ),
  };
}

/** Одна отправка с ретраями. Возвращает false вместо исключения: канал не критичен для запроса. */
async function sendChunk(
  chatId: number | string,
  text: string,
  options: TgSendOptions,
  buttons: TgButton[][] | undefined,
): Promise<boolean> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
    ...(buttons && buttons.length > 0 ? { reply_markup: inlineKeyboard(buttons) } : {}),
  };

  let lastNote = "";

  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
    const startedAt = Date.now();
    try {
      const res = await callApi("sendMessage", payload, SEND_TIMEOUT_MS);

      if (res.ok) {
        const ms = Date.now() - startedAt;
        if (ms > SLOW_SEND_MS) logWarn("telegram.send_slow", { chatId: String(chatId), ms });
        return true;
      }

      lastNote = `HTTP ${res.status} ${res.description ?? ""}`.trim();

      // 403 «бот заблокирован», 400 «чат не найден» — ретрай не поможет.
      if (res.status !== 429 && res.status >= 400 && res.status < 500) {
        logError("telegram.send_failed", { chatId: String(chatId), status: res.status, note: lastNote });
        return false;
      }

      if (attempt === SEND_ATTEMPTS) break;

      const delayMs =
        res.status === 429 && typeof res.retryAfterSec === "number"
          ? Math.min(res.retryAfterSec, MAX_RETRY_AFTER_SEC) * 1_000
          : RETRY_BASE_MS * attempt;
      logWarn("telegram.send_retry", { chatId: String(chatId), status: res.status, attempt, delayMs });
      await sleep(delayMs);
    } catch (error) {
      lastNote = error instanceof Error ? error.message : "сетевая ошибка";

      if (isDeliveryTimeout(error)) {
        logError("telegram.send_timeout", { chatId: String(chatId), attempt, note: lastNote });
        return false;
      }

      if (attempt === SEND_ATTEMPTS) break;
      logWarn("telegram.send_retry", { chatId: String(chatId), attempt, note: lastNote });
      await sleep(RETRY_BASE_MS * attempt);
    }
  }

  logError("telegram.send_failed", { chatId: String(chatId), attempts: SEND_ATTEMPTS, note: lastNote });
  return false;
}

/**
 * Отправка текста владельцу. Текст длиннее лимита режется на части; кнопки
 * вешаются на ПОСЛЕДНИЙ чанк, иначе владелец нажимает «Готово» под серединой
 * ответа.
 */
export async function tgSendMessage(
  chatId: number | string,
  text: string,
  opts: TgSendOptions = {},
): Promise<boolean> {
  if (!tgConfigured()) {
    logWarn("telegram.send_skipped", { reason: "не задан TELEGRAM_BOT_TOKEN" });
    return false;
  }

  const chunks = splitTextForMessenger(text, TELEGRAM_TEXT_LIMIT);
  if (chunks.length === 0) return true;

  let ok = true;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk === undefined) continue;
    const isLast = i === chunks.length - 1;
    const sent = await sendChunk(chatId, chunk, opts, isLast ? opts.buttons : undefined);
    if (!sent) ok = false;
  }
  return ok;
}

/**
 * Индикатор «печатает…»: владелец сразу видит реакцию, пока модель думает
 * несколько секунд. Fire-and-forget — ошибки глотаем, действие живёт ~5 с.
 */
export async function tgSendChatAction(
  chatId: number | string,
  action: "typing" = "typing",
): Promise<void> {
  if (!tgConfigured()) return;
  try {
    await callApi("sendChatAction", { chat_id: chatId, action }, ACTION_TIMEOUT_MS);
  } catch {
    // Индикатор не стоит того, чтобы ронять обработку сообщения.
  }
}

/** Сообщение в личный чат владельца — основной канал уведомлений системы. */
export async function tgNotifyOwner(
  text: string,
  opts?: Parameters<typeof tgSendMessage>[2],
): Promise<boolean> {
  const chatId = ownerChatId();
  if (chatId === null) {
    logWarn("telegram.owner_chat_missing", { reason: "не задан TELEGRAM_OWNER_CHAT_ID" });
    return false;
  }
  return tgSendMessage(chatId, text, opts);
}

/** Идентификатор канала для автопостинга: @username или -100…. */
export function contentChannelId(): string | null {
  const raw = optionalEnv("TELEGRAM_CONTENT_CHANNEL_ID");
  return raw && raw.trim().length > 0 ? raw.trim() : null;
}

export type ChannelPublishOutcome =
  | { kind: "published"; messageId: number }
  /** Точно НЕ опубликовано: Telegram отверг запрос осмысленно. */
  | { kind: "rejected"; reason: string }
  /**不 знаем: таймаут, 502 от прокси, разрыв. Повторять нельзя. */
  | { kind: "uncertain"; reason: string };

/**
 * Публикация поста в канал.
 *
 * Отдельная функция, а не `tgSendMessage`, по трём причинам, и каждая из них
 * в канале стоит дороже, чем в личном чате:
 *
 * 1. `tgSendMessage` режет длинный текст на части — пост на 4200 символов
 *    приехал бы в канал ДВУМЯ сообщениями.
 * 2. Внутри неё три попытки с ретраем на 5xx и сетевых ошибках — это второй
 *    пост в канале при первом же блипе связи.
 * 3. Она отвечает `boolean`, а здесь разница между «точно не ушло» и «не знаю»
 *    определяет, можно ли пробовать снова. Для подписчиков цена ошибки —
 *    публичный дубль, который придётся удалять руками.
 *
 * Ретраев нет вообще: единственная попытка, любой неоднозначный исход —
 * `uncertain`, дальше решает владелец.
 */
export async function tgPublishToChannel(
  text: string,
  opts: { parseMode?: "HTML" | "MarkdownV2"; timeoutMs?: number } = {},
): Promise<ChannelPublishOutcome> {
  const chatId = contentChannelId();
  if (!chatId) return { kind: "rejected", reason: "не задан TELEGRAM_CONTENT_CHANNEL_ID" };
  if (!tgConfigured()) return { kind: "rejected", reason: "не задан TELEGRAM_BOT_TOKEN" };

  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
  };

  try {
    const res = await callApi("sendMessage", payload, opts.timeoutMs ?? SEND_TIMEOUT_MS);

    if (res.ok) {
      const messageId = (res.data as { result?: { message_id?: number } } | null)?.result?.message_id;
      // Ответ без message_id — успех, которому нечем доказать себя. Считаем
      // неопределённостью: пост, возможно, в канале.
      if (typeof messageId !== "number") {
        return { kind: "uncertain", reason: "Telegram ответил ok, но без message_id" };
      }
      return { kind: "published", messageId };
    }

    // 400 «чат не найден», 403 «бот не админ канала» — запрос осмысленно
    // отвергнут, сообщения в канале точно нет. Это чинится настройкой, а не
    // повтором.
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      return { kind: "rejected", reason: `HTTP ${res.status} ${res.description ?? ""}`.trim() };
    }

    // 429 и 5xx: Telegram мог принять и не ответить.
    return { kind: "uncertain", reason: `HTTP ${res.status} ${res.description ?? ""}`.trim() };
  } catch (error) {
    const note = error instanceof Error ? error.message : "сетевая ошибка";
    // Таймаут — классический «запрос ушёл, ответ потерялся». Ровно тот случай,
    // ради которого во всём репозитории отправка не ретраится.
    return { kind: "uncertain", reason: isDeliveryTimeout(error) ? `таймаут: ${note}` : note };
  }
}

export interface SetWebhookResult {
  ok: boolean;
  url: string;
  response: unknown;
  description?: string;
}

export async function tgSetWebhook(url: string, secretToken?: string): Promise<SetWebhookResult> {
  const res = await tgApi("setWebhook", {
    url,
    ...(secretToken ? { secret_token: secretToken } : {}),
    allowed_updates: ["message", "callback_query"],
  });
  logInfo("telegram.set_webhook", { url, ok: res.ok, note: res.description });
  return { ok: res.ok, url, response: res.data, description: res.description };
}

export async function tgGetWebhookInfo(): Promise<TgApiResponse> {
  return tgApi("getWebhookInfo", {});
}
