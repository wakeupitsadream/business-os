import { Prisma, type MemoryCategory } from "@prisma/client";
import { prisma } from "@/core/db";
import { EMBEDDING_DIMENSIONS, llmEmbed } from "@/core/llm";
import { logInfo, logWarn } from "@/core/observability/logger";

/**
 * Запись фактов о владельце.
 *
 * Порядок операций здесь важнее краткости: сначала сохраняем текст, потом
 * пытаемся посчитать вектор. Наоборот было бы «чище» (одна запись вместо
 * двух), но тогда недоступность провайдера эмбеддингов означала бы потерю
 * самого факта. Текст без вектора всё ещё находится полнотекстовым поиском;
 * вектор без текста бесполезен.
 */

export interface SaveFactInput {
  text: string;
  category?: MemoryCategory;
  /** 1 — фон, 2 — обычный, 3 — важный (всегда в контексте). */
  importance?: number;
  pinned?: boolean;
  source?: string;
}

export interface SavedFact {
  id: string;
  text: string;
  /** Посчитался ли вектор. false — факт найдётся только по словам. */
  embedded: boolean;
}

export async function saveFact(input: SaveFactInput): Promise<SavedFact> {
  const text = input.text.trim();
  if (text.length === 0) throw new Error("Пустой факт сохранять нечего");

  const fact = await prisma.memoryFact.create({
    data: {
      text,
      category: input.category ?? "BUSINESS",
      importance: clampImportance(input.importance),
      pinned: input.pinned ?? false,
      source: input.source ?? null,
    },
    select: { id: true, text: true },
  });

  const embedded = await attachEmbedding(fact.id, text);
  return { ...fact, embedded };
}

/**
 * Считает и записывает вектор. Возвращает false, если не вышло — это не
 * ошибка вызывающего, а деградация: факт уже сохранён.
 */
export async function attachEmbedding(factId: string, text: string): Promise<boolean> {
  try {
    const [vector] = await llmEmbed([text], { feature: "memory.embed" });
    if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
      logWarn("memory.embedding_shape_unexpected", { factId, got: vector?.length ?? 0 });
      return false;
    }

    await prisma.$executeRaw`
      UPDATE "MemoryFact"
      SET embedding = ${toVectorLiteral(vector)}::vector
      WHERE id = ${factId}
    `;
    return true;
  } catch (e) {
    // Самый ожидаемый случай — у провайдера просто нет эмбеддингов. Это
    // предусмотренный режим работы, а не поломка, поэтому warn, а не error.
    logWarn("memory.embedding_unavailable", {
      factId,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/** Пометить факт неактуальным (не удаляем — история важна). */
export async function retireFact(factId: string): Promise<boolean> {
  const res = await prisma.memoryFact.updateMany({
    where: { id: factId, active: true },
    data: { active: false },
  });
  return res.count > 0;
}

/**
 * Дозаполнение векторов у фактов, сохранённых без них.
 *
 * Нужно, когда эмбеддинги были недоступны, а потом появились: без этого такие
 * факты навсегда остались бы доступны только словесному поиску.
 */
export async function backfillEmbeddings(limit = 20): Promise<{ done: number; failed: number }> {
  const rows = await prisma.$queryRaw<Array<{ id: string; text: string }>>`
    SELECT id, text FROM "MemoryFact"
    WHERE active AND embedding IS NULL
    ORDER BY "createdAt" DESC
    LIMIT ${limit}
  `;

  let done = 0;
  let failed = 0;
  for (const row of rows) {
    if (await attachEmbedding(row.id, row.text)) done += 1;
    else failed += 1;
    // Первый же отказ означает, что провайдер эмбеддингов недоступен целиком —
    // остальные попытки только сожгут время джобы и попадут в счёт.
    if (failed > 0) break;
  }

  if (done > 0 || failed > 0) logInfo("memory.backfill", { done, failed, candidates: rows.length });
  return { done, failed };
}

function clampImportance(value: number | undefined): number {
  if (value === undefined) return 2;
  return Math.min(3, Math.max(1, Math.round(value)));
}

/**
 * Формат литерала pgvector: '[0.1,0.2,…]'.
 * Значения приводим к конечным числам — NaN или Infinity в векторе роняют
 * вставку сообщением, по которому причину не найти.
 */
export function toVectorLiteral(vector: number[]): string {
  const parts = vector.map((v) => (Number.isFinite(v) ? v : 0));
  return `[${parts.join(",")}]`;
}

export { Prisma };
