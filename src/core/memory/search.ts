import { prisma } from "@/core/db";
import { EMBEDDING_DIMENSIONS, llmEmbed } from "@/core/llm";
import { logWarn } from "@/core/observability/logger";
import { toVectorLiteral } from "./facts";

/**
 * Поиск фактов о владельце для контекста агента.
 *
 * Два пути, и второй не запасной «на всякий случай», а обязательный.
 * Векторный поиск требует, чтобы провайдер отдавал эмбеддинги — а это не
 * гарантировано и проверяется только живым вызовом. Если бы память умела
 * только вектор, отсутствие одной возможности у провайдера выключало бы
 * секретарю всю личную историю разом.
 */

export interface RecalledFact {
  id: string;
  text: string;
  category: string;
  importance: number;
  pinned: boolean;
  /** Как факт найден — видно в логах и удобно при отладке качества. */
  via: "vector" | "text" | "always";
}

export interface RecallOptions {
  limit?: number;
  /** Порог косинусного расстояния: чем меньше, тем ближе по смыслу. */
  maxDistance?: number;
}

const DEFAULT_LIMIT = 8;

/**
 * 0.6 по косинусному расстоянию — примерно «про то же самое, другими словами».
 * Выше начинает подмешиваться случайное, и агент уверенно вспоминает то, чего
 * владелец не говорил: это хуже, чем не вспомнить ничего.
 */
const DEFAULT_MAX_DISTANCE = 0.6;

export async function recallFacts(
  query: string,
  opts: RecallOptions = {},
): Promise<RecalledFact[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const always = await loadAlwaysRelevant();

  const text = query.trim();
  if (text.length === 0) return always;

  const found = (await searchByVector(text, limit, opts.maxDistance)) ?? (await searchByText(text, limit));

  return dedupe([...always, ...found], limit + always.length);
}

/**
 * Факты, которые входят в контекст независимо от вопроса: закреплённые
 * владельцем и помеченные как важные. Их немного по определению, и именно они
 * задают тон общения — их нельзя ставить в зависимость от совпадения слов.
 */
async function loadAlwaysRelevant(): Promise<RecalledFact[]> {
  const rows = await prisma.memoryFact.findMany({
    where: {
      active: true,
      OR: [{ pinned: true }, { importance: 3 }],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }],
    },
    orderBy: [{ pinned: "desc" }, { importance: "desc" }, { createdAt: "desc" }],
    take: 12,
    select: { id: true, text: true, category: true, importance: true, pinned: true },
  });
  return rows.map((r) => ({ ...r, via: "always" as const }));
}

/** null — векторный путь недоступен, вызывающий должен идти в текстовый. */
async function searchByVector(
  query: string,
  limit: number,
  maxDistance = DEFAULT_MAX_DISTANCE,
): Promise<RecalledFact[] | null> {
  let vector: number[] | undefined;
  try {
    [vector] = await llmEmbed([query], { feature: "memory.recall" });
  } catch (e) {
    logWarn("memory.recall_vector_unavailable", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
  if (!vector || vector.length !== EMBEDDING_DIMENSIONS) return null;

  try {
    const rows = await prisma.$queryRaw<
      Array<{
        id: string;
        text: string;
        category: string;
        importance: number;
        pinned: boolean;
        distance: number;
      }>
    >`
      SELECT id, text, category::text AS category, importance, pinned,
             (embedding <=> ${toVectorLiteral(vector)}::vector) AS distance
      FROM "MemoryFact"
      WHERE active
        AND embedding IS NOT NULL
        AND ("expiresAt" IS NULL OR "expiresAt" > now())
      ORDER BY distance ASC
      LIMIT ${limit}
    `;

    return rows
      .filter((r) => Number(r.distance) <= maxDistance)
      .map((r) => ({
        id: r.id,
        text: r.text,
        category: r.category,
        importance: r.importance,
        pinned: r.pinned,
        via: "vector" as const,
      }));
  } catch (e) {
    // Расширение vector могли не включить в базе — тогда падает сам запрос.
    logWarn("memory.recall_vector_query_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * Поиск по словам. Работает без каких-либо внешних сервисов, поэтому это тот
 * путь, который обязан быть всегда.
 *
 * Про его предел стоит знать честно: он находит по СЛОВАМ, а не по смыслу.
 * Русская морфология покрыта («Казань» находится по «Казани», «созвон» по
 * «созвонов»), но синонимы и родственные понятия — нет: запрос «сон» не найдёт
 * факт «плохо спит после полуночи», потому что это разные леммы. Ровно такие
 * связи и находит векторный путь; здесь мы получаем меньше, но всегда.
 */
async function searchByText(query: string, limit: number): Promise<RecalledFact[]> {
  try {
    const rows = await prisma.$queryRaw<
      Array<{
        id: string;
        text: string;
        category: string;
        importance: number;
        pinned: boolean;
      }>
    >`
      SELECT id, text, category::text AS category, importance, pinned
      FROM "MemoryFact"
      WHERE active
        AND ("expiresAt" IS NULL OR "expiresAt" > now())
        AND to_tsvector('russian', text) @@ plainto_tsquery('russian', ${query})
      ORDER BY ts_rank(to_tsvector('russian', text), plainto_tsquery('russian', ${query})) DESC,
               importance DESC
      LIMIT ${limit}
    `;
    if (rows.length > 0) return rows.map((r) => ({ ...r, via: "text" as const }));

    // Слова не совпали — пробуем по похожести написания: word_similarity
    // сравнивает запрос с лучшим фрагментом текста, а не строки целиком
    // (обычная similarity на коротком запросе против длинного факта всегда
    // ниже любого разумного порога и не находит ничего).
    return await searchByTrigram(query, limit);
  } catch (e) {
    // Память не должна ронять ответ владельцу: без неё секретарь беднее,
    // но работает.
    logWarn("memory.recall_text_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

/**
 * Порог похожести, подобранный на живых данных: настоящие совпадения дают
 * 0.71–0.91, посторонние запросы («погода», «кошка») — не выше 0.29. Это
 * откат отката: полнотекстовый поиск уже отработал и ничего не нашёл, поэтому
 * точность здесь важнее полноты — уверенно вспомнить не то хуже, чем не
 * вспомнить ничего.
 */
const TRIGRAM_THRESHOLD = 0.5;

async function searchByTrigram(query: string, limit: number): Promise<RecalledFact[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      text: string;
      category: string;
      importance: number;
      pinned: boolean;
    }>
  >`
    SELECT id, text, category::text AS category, importance, pinned
    FROM "MemoryFact"
    WHERE active
      AND ("expiresAt" IS NULL OR "expiresAt" > now())
      AND word_similarity(${query}, text) > ${TRIGRAM_THRESHOLD}
    ORDER BY word_similarity(${query}, text) DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({ ...r, via: "text" as const }));
}

function dedupe(facts: RecalledFact[], limit: number): RecalledFact[] {
  const seen = new Set<string>();
  const out: RecalledFact[] = [];
  for (const f of facts) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
    if (out.length >= limit) break;
  }
  return out;
}

/** Блок памяти для системного промпта. Пусто — значит блока не будет вовсе. */
export function formatFactsForPrompt(facts: RecalledFact[]): string {
  if (facts.length === 0) return "";
  const lines = facts.map((f) => `- ${f.text}`);
  return [
    "## Что я помню о владельце",
    ...lines,
    "",
    "Это записи из прошлых разговоров. Опирайся на них, но не пересказывай без нужды.",
  ].join("\n");
}
