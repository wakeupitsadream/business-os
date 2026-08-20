import { logWarn } from "@/core/observability/logger";
import {
  filterHealthy,
  resetBreaker,
  tripBreaker,
} from "./circuit-breaker";
import {
  LlmUnavailableError,
  NOT_CONFIGURED_MESSAGE,
  presetTimeoutMs,
  resolveVariants,
  type LlmPreset,
  type LlmVariant,
} from "./gateways";
import { assertWithinDailyBudget, recordUsage } from "./usage";

/**
 * Вызов чат-моделей через каскад шлюзов.
 *
 * Порядок обработки провала: ретрай внутри шлюза (транзиентные 429/5xx/сеть) →
 * следующий шлюз → LlmUnavailableError. Жёсткий провал варианта открывает
 * circuit breaker, чтобы следующие запросы не платили ту же задержку.
 */

/**
 * Часть мультимодального сообщения — формат OpenAI-совместимых шлюзов.
 * Картинка едет data-URL-ом: у шлюза нет доступа к нашим файлам, а выложить
 * чек владельца на публичный хостинг ради распознавания — не вариант.
 */
export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** Строка для текста; массив частей — когда во входе есть картинка. */
  content: string | LlmContentPart[];
  tool_call_id?: string;
  name?: string;
  tool_calls?: unknown;
}

export interface LlmToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface LlmChatResult {
  text: string;
  toolCalls: LlmToolCall[];
  /** Исходный блок tool_calls провайдера — для возврата в историю диалога. */
  rawToolCalls: unknown;
  gateway: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface LlmChatOptions {
  feature: string;
  messages: LlmMessage[];
  preset?: LlmPreset;
  tools?: LlmToolDef[];
  temperature?: number;
  maxTokens?: number;
  runId?: string;
  signal?: AbortSignal;
}

/** Попыток на один вариант «шлюз+модель» (первая + один ретрай). */
const MAX_ATTEMPTS = 2;
const BACKOFF_BASE_MS = 500;
/** Не начинать новую попытку, если до общего дедлайна осталось меньше. */
const MIN_ATTEMPT_MS = 3_000;

const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * Природа провала обращения к шлюзу. От неё зависят два независимых решения:
 * повторять ли попытку на ТОМ ЖЕ шлюзе и считать ли шлюз больным.
 *
 *   timeout  — шлюз держит соединение и молчит. Повторять бессмысленно
 *              (второй такой же таймаут просто съест бюджет резерва), а вот
 *              больным его пометить нужно: это и есть деградация.
 *   network  — соединение не установилось. Повторить стоит, шлюз мог моргнуть.
 *   http     — шлюз ответил кодом ошибки. Транзиентность определяется кодом.
 *   shape    — ответ не разобрать. Обычно заглушка балансировщика, а не наша
 *              вина, поэтому считается признаком нездоровья шлюза.
 */
type GatewayErrorKind = "timeout" | "network" | "http" | "shape";

/** Провал одного HTTP-обращения к шлюзу. */
class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly kind: GatewayErrorKind = "http",
  ) {
    super(message);
    this.name = "GatewayError";
  }

  /**
   * Говорит ли эта ошибка о нездоровье ШЛЮЗА (в отличие от кривизны нашего
   * собственного запроса). Открывать брейкер на 400/401/413/422 нельзя: один
   * неверно собранный вызов пометил бы исправный шлюз больным на 45 секунд —
   * для всех остальных функций системы разом.
   */
  get indicatesUnhealthyGateway(): boolean {
    if (this.kind !== "http") return true;
    if (this.status === null) return true;
    return this.status === 429 || this.status >= 500;
  }
}

/**
 * Бюджет времени каскада исчерпан до того, как вариант успели опросить.
 *
 * Отдельный тип, а не GatewayError, ровно по одной причине: такой вариант НЕ
 * трогали, и записывать ему провал в LlmUsage или открывать его брейкер —
 * значит оболгать здоровый шлюз. Раньше именно это и происходило: зависший
 * первичный шлюз съедал весь бюджет, резерв получал ложную отметку «больной»,
 * после чего fail-open возвращал оба варианта в исходном порядке — и каскад
 * снова начинал с зависшего. Механизм отказоустойчивости работал против себя.
 */
class DeadlineExceededError extends Error {
  constructor() {
    super("исчерпан бюджет времени каскада");
    this.name = "DeadlineExceededError";
  }
}

/** Отмена пришла снаружи (пользователь закрыл вкладку) — каскад не продолжаем. */
export class ExternalAbortError extends Error {
  constructor() {
    super("Запрос к ИИ отменён вызывающей стороной");
    this.name = "ExternalAbortError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

interface WireMessage {
  role: string;
  content: string | LlmContentPart[];
  tool_call_id?: string;
  name?: string;
  tool_calls?: unknown;
}

function toWireMessages(messages: readonly LlmMessage[]): WireMessage[] {
  return messages.map((m) => {
    const wire: WireMessage = { role: m.role, content: m.content };
    if (m.role === "tool") {
      // Без tool_call_id провайдер не сматчит результат с вызовом и вернёт 400.
      if (m.tool_call_id) wire.tool_call_id = m.tool_call_id;
      if (m.name) wire.name = m.name;
      return wire;
    }
    if (m.name) wire.name = m.name;
    if (m.tool_calls) wire.tool_calls = m.tool_calls;
    return wire;
  });
}

export function buildChatBody(model: string, opts: LlmChatOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: toWireMessages(opts.messages),
  };
  // temperature/max_tokens шлём только если заданы: часть моделей отклоняет
  // эти поля, а дефолт провайдера всегда валиден.
  if (opts.temperature !== undefined) body["temperature"] = opts.temperature;
  if (opts.maxTokens !== undefined) body["max_tokens"] = opts.maxTokens;
  if (opts.tools && opts.tools.length > 0) {
    body["tools"] = opts.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body["tool_choice"] = "auto";
  }
  return body;
}

/** Текст ответа: строка либо массив частей (так отдают Anthropic-совместимые прокси). */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (isRecord(part) && typeof part["text"] === "string") return part["text"];
      return "";
    })
    .join("");
}

function parseToolCalls(raw: unknown): LlmToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: LlmToolCall[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const fn = item["function"];
    if (!isRecord(fn)) continue;
    const name = fn["name"];
    if (typeof name !== "string" || name.length === 0) continue;
    const args = fn["arguments"];
    const id = item["id"];
    calls.push({
      id: typeof id === "string" && id.length > 0 ? id : `call_${calls.length}`,
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
    });
  }
  return calls;
}

interface ParsedChat {
  text: string;
  toolCalls: LlmToolCall[];
  /**
   * Блок tool_calls в том виде, в каком его прислал провайдер. Нужен, чтобы
   * вернуть ответ модели в историю без потерь: провайдер отвергает результат
   * инструмента, которому не предшествует ИСХОДНЫЙ вызов, а пересобранный по
   * нашим типам легко разойдётся с ним в мелочи.
   */
  rawToolCalls: unknown;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Разбор ответа шлюза. null = ответ не той формы, вариант считается провальным.
 * Форме JSON от агрегатора доверять нельзя: и HTML-заглушка балансировщика, и
 * пустой `choices` приходят со статусом 200.
 */
export function parseChatResponse(json: unknown): ParsedChat | null {
  if (!isRecord(json)) return null;
  const choices = json["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!isRecord(first)) return null;
  const message = first["message"];
  if (!isRecord(message)) return null;

  const text = extractText(message["content"]).trim();
  const toolCalls = parseToolCalls(message["tool_calls"]);
  if (text.length === 0 && toolCalls.length === 0) return null;

  const usage = isRecord(json["usage"]) ? json["usage"] : {};
  return {
    text,
    toolCalls,
    rawToolCalls: message["tool_calls"] ?? null,
    inputTokens: toInt(usage["prompt_tokens"]),
    outputTokens: toInt(usage["completion_tokens"]),
  };
}

function combineSignals(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([timeout, external]) : timeout;
}

/** Один POST к шлюзу. Внутренний хелпер, используется также в embed.ts. */
export async function postJson(params: {
  url: string;
  apiKey: string;
  body: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(params.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params.body),
      signal: combineSignals(params.timeoutMs, params.signal),
    });
  } catch (e) {
    if (params.signal?.aborted) throw new ExternalAbortError();
    const message = e instanceof Error ? e.message : String(e);

    // Таймаут и обрыв соединения — разные истории, хотя оба прилетают сюда.
    // Соединение не установилось — шлюз мог моргнуть, повтор оправдан.
    // Шлюз молчал до истечения таймаута — повтор почти наверняка кончится
    // вторым таким же таймаутом, а времени на резервный шлюз уже не останется.
    const timedOut =
      e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

    throw new GatewayError(message, null, !timedOut, timedOut ? "timeout" : "network");
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new GatewayError(
      `HTTP ${res.status}: ${detail}`,
      res.status,
      RETRYABLE_STATUSES.has(res.status),
      "http",
    );
  }

  try {
    return await res.json();
  } catch {
    // Битое тело при 200 — ретраить не стоит: возможно, запрос уже оплачен.
    throw new GatewayError("шлюз вернул не JSON", res.status, false, "shape");
  }
}

async function callWithRetries(params: {
  url: string;
  apiKey: string;
  body: unknown;
  attemptTimeoutMs: number;
  deadline: number;
  signal?: AbortSignal;
  variantKey: string;
}): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = params.deadline - Date.now();
    if (remaining < MIN_ATTEMPT_MS) {
      // Если шлюз уже успел провалиться — отдаём его настоящую ошибку.
      // Если нет (времени не хватило ещё до первой попытки) — сигнализируем
      // именно исчерпание бюджета, чтобы вызывающий не записал провал шлюзу,
      // к которому не обращался.
      throw lastError ?? new DeadlineExceededError();
    }
    try {
      return await postJson({
        url: params.url,
        apiKey: params.apiKey,
        body: params.body,
        timeoutMs: Math.min(params.attemptTimeoutMs, remaining),
        signal: params.signal,
      });
    } catch (e) {
      if (e instanceof ExternalAbortError) throw e;
      lastError = e;
      const retryable = e instanceof GatewayError && e.retryable;
      if (!retryable || attempt === MAX_ATTEMPTS) throw e;
      const backoff = BACKOFF_BASE_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
      logWarn("llm.attempt_retry", {
        variant: params.variantKey,
        attempt,
        backoffMs: backoff,
        error: e instanceof Error ? e.message : String(e),
      });
      await sleep(backoff);
    }
  }
  throw lastError ?? new GatewayError("неизвестный провал шлюза", null, false);
}

/**
 * Общий потолок времени на весь каскад.
 *
 * Потолок нужен, чтобы полная деградация всех шлюзов не держала вызывающего
 * бесконечно. Но он обязан зависеть от ЧИСЛА вариантов. Фиксированные «два
 * таймаута» (столько же, сколько бюджет одного варианта при двух попытках)
 * целиком съедались первым же зависшим шлюзом — и резерв, ради которого весь
 * каскад написан, не получал ни единой попытки. Хуже того, пропущенному
 * варианту доставалась отметка «больной», после чего fail-open возвращал оба
 * варианта в исходном порядке, и следующий запрос снова начинал с зависшего.
 *
 * Слагаемое сверху — запас на бэкоффы между попытками и разбор ответов.
 */
export function cascadeBudgetMs(attemptTimeoutMs: number, variantCount: number): number {
  return attemptTimeoutMs * (Math.max(1, variantCount) + 1);
}

export async function llmChat(opts: LlmChatOptions): Promise<LlmChatResult> {
  const preset: LlmPreset = opts.preset ?? "smart";
  const all = resolveVariants(preset);
  if (all.length === 0) throw new LlmUnavailableError(NOT_CONFIGURED_MESSAGE);

  await assertWithinDailyBudget(preset, opts.feature);

  const variants: LlmVariant[] = filterHealthy(all, (v) => v.key);
  const attemptTimeoutMs = presetTimeoutMs(preset);

  const deadline = Date.now() + cascadeBudgetMs(attemptTimeoutMs, variants.length);

  let lastError: unknown;
  for (const variant of variants) {
    if (opts.signal?.aborted) throw new ExternalAbortError();

    const body = buildChatBody(variant.model, opts);
    const startedAt = Date.now();
    try {
      const json = await callWithRetries({
        url: `${variant.gateway.baseUrl}/chat/completions`,
        apiKey: variant.gateway.apiKey,
        body,
        attemptTimeoutMs,
        deadline,
        signal: opts.signal,
        variantKey: variant.key,
      });
      const parsed = parseChatResponse(json);
      if (!parsed) throw new GatewayError("ответ шлюза не соответствует ожидаемой форме", null, false);

      const latencyMs = Date.now() - startedAt;
      resetBreaker(variant.key);
      await recordUsage({
        feature: opts.feature,
        preset,
        gateway: variant.gateway.id,
        model: variant.model,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        latencyMs,
        ok: true,
        runId: opts.runId,
      });

      return {
        text: parsed.text,
        toolCalls: parsed.toolCalls,
        rawToolCalls: parsed.rawToolCalls,
        gateway: variant.gateway.id,
        model: variant.model,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        latencyMs,
      };
    } catch (e) {
      if (e instanceof ExternalAbortError) throw e;
      lastError = e;
      const message = e instanceof Error ? e.message : String(e);

      // К этому варианту не обращались — времени не осталось. Он ни в чём не
      // виноват: ни отметки «больной», ни строки в учёте расходов.
      if (e instanceof DeadlineExceededError) {
        logWarn("llm.variant_skipped_no_time", {
          feature: opts.feature,
          preset,
          gateway: variant.gateway.id,
          model: variant.model,
        });
        break;
      }

      // Брейкер открываем только на признаках нездоровья ШЛЮЗА. Ошибка нашего
      // собственного запроса (400, 401, 413, 422) — не повод объявлять
      // исправный шлюз больным для всех остальных функций на 45 секунд.
      const unhealthy = !(e instanceof GatewayError) || e.indicatesUnhealthyGateway;
      if (unhealthy) tripBreaker(variant.key);

      logWarn("llm.gateway_failed", {
        feature: opts.feature,
        preset,
        gateway: variant.gateway.id,
        model: variant.model,
        latencyMs: Date.now() - startedAt,
        breakerTripped: unhealthy,
        error: message,
      });
      await recordUsage({
        feature: opts.feature,
        preset,
        gateway: variant.gateway.id,
        model: variant.model,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - startedAt,
        ok: false,
        error: message,
        runId: opts.runId,
      });
    }
  }

  throw new LlmUnavailableError(
    "ИИ временно недоступен: ни один шлюз не ответил. Причина в логах " +
      `(llm.gateway_failed). Последняя ошибка: ${lastError instanceof Error ? lastError.message : "неизвестна"}`,
  );
}
