import { logWarn } from "@/core/observability/logger";
import { filterHealthy, resetBreaker, tripBreaker } from "./circuit-breaker";
import { ExternalAbortError, postJson } from "./chat";
import {
  LlmUnavailableError,
  NOT_CONFIGURED_MESSAGE,
  presetTimeoutMs,
  resolveVariants,
} from "./gateways";
import { assertWithinDailyBudget, recordUsage } from "./usage";

/**
 * Эмбеддинги для векторного поиска по памяти (`MemoryFact.embedding`).
 * Тот же каскад шлюзов, что и у чата, но без ретраев формы ответа: запрос
 * идемпотентен и дёшев, проще сразу уйти на следующий шлюз.
 */

/**
 * Размерность жёстко зашита, потому что колонка в БД — `vector(1536)`.
 * Вектор другой длины не «слегка неточен», он не запишется вовсе, и ошибка
 * всплывёт глубоко в модуле памяти вместо места, где её видно.
 */
export const EMBEDDING_DIMENSIONS = 1536;

/** Разбиение на пачки: провайдеры ограничивают и число входов, и размер тела. */
const MAX_BATCH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Разбор ответа `/embeddings`. null = форма не та (вариант провалился).
 * Порядок восстанавливаем по полю `index`: спецификация не гарантирует, что
 * элементы придут в порядке входов, а перепутанные векторы дали бы тихо
 * неверный поиск по памяти — баг, который никак себя не проявит в логах.
 */
export function parseEmbeddingResponse(
  json: unknown,
  expected: number,
): { vectors: number[][]; inputTokens: number } | null {
  if (!isRecord(json)) return null;
  const data = json["data"];
  if (!Array.isArray(data) || data.length !== expected) return null;

  const vectors: number[][] = new Array<number[]>(expected);
  const filled = new Set<number>();
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    if (!isRecord(item)) return null;
    const embedding = item["embedding"];
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) return null;
    if (!embedding.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    const rawIndex = item["index"];
    const index = typeof rawIndex === "number" && Number.isInteger(rawIndex) ? rawIndex : i;
    if (index < 0 || index >= expected) return null;
    vectors[index] = embedding as number[];
    filled.add(index);
  }
  // Считаем заполненные позиции явно: два элемента с одинаковым `index`
  // оставили бы дырку в массиве, а обход дырок пропускает `some`/`every`.
  if (filled.size !== expected) return null;

  const usage = isRecord(json["usage"]) ? json["usage"] : {};
  const prompt = usage["prompt_tokens"];
  return {
    vectors,
    inputTokens: typeof prompt === "number" && Number.isFinite(prompt) ? Math.round(prompt) : 0,
  };
}

async function embedBatch(
  batch: string[],
  opts: { feature: string; runId?: string; signal?: AbortSignal },
): Promise<number[][]> {
  const all = resolveVariants("embed");
  if (all.length === 0) throw new LlmUnavailableError(NOT_CONFIGURED_MESSAGE);

  const variants = filterHealthy(all, (v) => v.key);
  const timeoutMs = presetTimeoutMs("embed");
  let lastError: unknown;

  for (const variant of variants) {
    if (opts.signal?.aborted) throw new ExternalAbortError();
    const startedAt = Date.now();
    try {
      const json = await postJson({
        url: `${variant.gateway.baseUrl}/embeddings`,
        apiKey: variant.gateway.apiKey,
        body: { model: variant.model, input: batch },
        timeoutMs,
        signal: opts.signal,
      });
      const parsed = parseEmbeddingResponse(json, batch.length);
      if (!parsed) throw new Error("ответ шлюза не соответствует ожидаемой форме");

      const latencyMs = Date.now() - startedAt;
      resetBreaker(variant.key);
      await recordUsage({
        feature: opts.feature,
        preset: "embed",
        gateway: variant.gateway.id,
        model: variant.model,
        inputTokens: parsed.inputTokens,
        outputTokens: 0,
        latencyMs,
        ok: true,
        runId: opts.runId,
      });
      return parsed.vectors;
    } catch (e) {
      if (e instanceof ExternalAbortError) throw e;
      lastError = e;
      const message = e instanceof Error ? e.message : String(e);
      tripBreaker(variant.key);
      logWarn("llm.embed_failed", {
        feature: opts.feature,
        gateway: variant.gateway.id,
        model: variant.model,
        error: message,
      });
      await recordUsage({
        feature: opts.feature,
        preset: "embed",
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
    "Не удалось построить эмбеддинги: ни один шлюз не ответил. " +
      `Последняя ошибка: ${lastError instanceof Error ? lastError.message : "неизвестна"}`,
  );
}

export async function llmEmbed(
  texts: string[],
  opts: { feature: string; runId?: string; signal?: AbortSignal },
): Promise<number[][]> {
  if (texts.length === 0) return [];

  await assertWithinDailyBudget("embed", opts.feature);

  const result: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const batch = texts.slice(i, i + MAX_BATCH);
    result.push(...(await embedBatch(batch, opts)));
  }
  return result;
}
