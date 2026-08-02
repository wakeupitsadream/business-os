import { prisma } from "@/core/db";
import { formatPhone } from "../phone";

/**
 * Список кандидатов для экрана лидогена.
 *
 * Порядок — по оценке ИИ, сначала лучшие. Пока скоринга нет, оценка пуста у
 * всех, и порядок вырождается в «свежие сверху»: это честнее, чем выдумывать
 * приоритет из рейтинга справочника, который к готовности покупать отношения
 * не имеет.
 */

export interface CandidateRow {
  id: string;
  name: string;
  city: string | null;
  address: string | null;
  phone: string | null;
  site: string | null;
  rating: number | null;
  reviewsCount: number | null;
  score: number | null;
  source: string;
}

export async function listCandidates(limit = 100): Promise<CandidateRow[]> {
  const rows = await prisma.parsedCompany.findMany({
    where: { status: "NEW" },
    orderBy: [{ score: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: limit,
    select: {
      id: true,
      name: true,
      city: true,
      address: true,
      phoneNormalized: true,
      phones: true,
      site: true,
      rating: true,
      reviewsCount: true,
      score: true,
      source: true,
    },
  });

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    city: r.city,
    address: r.address,
    // Нормализованный — для показа; если он не разобрался, показываем как
    // отдал источник: владельцу нужен номер, а не наша уверенность в нём.
    phone: formatPhone(r.phoneNormalized) ?? r.phones[0] ?? null,
    site: r.site,
    rating: r.rating,
    reviewsCount: r.reviewsCount,
    score: r.score,
    source: r.source,
  }));
}

/** Сколько кандидатов ждёт разбора — для счётчика на экране продаж. */
export async function countNewCandidates(): Promise<number> {
  return prisma.parsedCompany.count({ where: { status: "NEW" } });
}
