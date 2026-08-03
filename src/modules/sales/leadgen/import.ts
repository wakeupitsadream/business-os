import type { LeadSource } from "@prisma/client";
import { prisma } from "@/core/db";
import { logInfo } from "@/core/observability/logger";
import { createLead } from "../leads";
import { PipelineError } from "../pipeline";

/**
 * Перенос кандидата лидогена в CRM — и трёхуровневый дедуп при нём.
 *
 * Уровни разные не по прихоти, а по надёжности признака.
 *
 * 1. **`[source, externalId]`** — тождество внутри источника. Абсолютно
 *    надёжно, поэтому держится уникальным индексом и работает само.
 * 2. **Телефон** — тождество между источниками. Тоже надёжно: один и тот же
 *    автосервис приезжает из Яндекса и из 2ГИС под разными названиями, но с
 *    одним номером. Склеивается автоматически.
 * 3. **Похожее название в том же городе** — догадка. «Автосервис на Ленина» и
 *    «Автосервис на Ленина, 5» могут быть одним делом, а могут быть двумя
 *    точками сети. Автоматическая склейка здесь однажды соединит двух разных
 *    клиентов в одного, и разобрать это потом будет уже нечем — поэтому
 *    третий уровень только СПРАШИВАЕТ.
 */

/**
 * Порог похожести. 0.6 подобран как «опечатка и приписка — да, другое
 * название — нет». Ниже начинают совпадать любые два автосервиса, выше —
 * перестают совпадать очевидные дубли с лишним словом.
 */
const SIMILARITY_THRESHOLD = 0.6;

/** Сколько похожих показываем владельцу: список длиннее просто не читают. */
const SIMILAR_LIMIT = 5;

const SOURCE_MAP: Record<string, LeadSource> = {
  yandex_geo: "YANDEX_GEO",
  two_gis: "TWO_GIS",
};

export interface SimilarLead {
  leadId: string;
  name: string;
  city: string | null;
  similarity: number;
}

export interface ImportCandidateResult {
  /**
   * `imported` — завели нового; `merged` — подклеили по телефону;
   * `needs_confirmation` — нашли похожих, решение за владельцем;
   * `already` — кандидат уже разобран.
   */
  outcome: "imported" | "merged" | "needs_confirmation" | "already";
  leadId?: string;
  similar?: SimilarLead[];
}

export interface ImportCandidateOptions {
  /** Ответ владельца на третий уровень: «это тот же лид». */
  mergeIntoLeadId?: string;
  /** Ответ владельца на третий уровень: «нет, это другая компания». */
  asNewLead?: boolean;
}

export async function importCandidate(
  candidateId: string,
  options: ImportCandidateOptions = {},
): Promise<ImportCandidateResult> {
  const candidate = await prisma.parsedCompany.findUnique({ where: { id: candidateId } });
  if (!candidate) throw new PipelineError("Кандидат не найден.", "not_found");

  if (candidate.status === "IMPORTED" && candidate.leadId) {
    return { outcome: "already", leadId: candidate.leadId };
  }

  // Владелец подтвердил склейку с конкретным лидом — третий уровень пройден.
  if (options.mergeIntoLeadId) {
    const lead = await prisma.lead.findUnique({
      where: { id: options.mergeIntoLeadId },
      select: { id: true },
    });
    if (!lead) throw new PipelineError("Лид для склейки не найден.", "not_found");

    await fillEmptyFields(lead.id, candidate);
    await markImported(candidate.id, lead.id);
    logInfo("sales.candidate_merged_manually", { candidateId: candidate.id, leadId: lead.id });
    return { outcome: "merged", leadId: lead.id };
  }

  // Уровень 3 спрашивается ДО создания: найдя похожих, мы не заводим ничего,
  // иначе ответ «да, это тот же» пришёл бы к уже созданному дублю.
  if (!options.asNewLead) {
    const byPhone = candidate.phoneNormalized
      ? await prisma.lead.findUnique({
          where: { phoneNormalized: candidate.phoneNormalized },
          select: { id: true },
        })
      : null;

    // Совпадение по телефону сильнее похожести названий — спрашивать не о чем.
    if (!byPhone) {
      const similar = await findSimilarLeads(candidate.name, candidate.city);
      if (similar.length > 0) {
        return { outcome: "needs_confirmation", similar };
      }
    }
  }

  const { leadId, merged } = await createLead({
    name: candidate.name,
    niche: candidate.niche,
    city: candidate.city,
    source: SOURCE_MAP[candidate.source] ?? "MANUAL",
    phone: candidate.phoneNormalized ?? candidate.phones[0] ?? null,
    site: candidate.site,
    address: candidate.address,
    contact: candidate.isPersonalData
      ? { phone: candidate.phones[0] ?? null, isPersonalData: true }
      : undefined,
  });

  // Оценка переносится только на нового лида. У существующего она своя —
  // возможно, поправленная владельцем, — и затирать её справочными данными
  // из свежей выдачи незачем.
  if (!merged && candidate.score !== null) {
    await prisma.lead.update({
      where: { id: leadId },
      data: { aiScore: candidate.score, aiScoreData: candidate.scoreData ?? undefined },
    });
  }

  await markImported(candidate.id, leadId);
  logInfo("sales.candidate_imported", { candidateId: candidate.id, leadId, merged });
  return { outcome: merged ? "merged" : "imported", leadId };
}

/** Отказ владельца: кандидат больше не показывается, но и не удаляется. */
export async function skipCandidate(candidateId: string): Promise<boolean> {
  const skipped = await prisma.parsedCompany.updateMany({
    where: { id: candidateId, status: "NEW" },
    data: { status: "SKIPPED" },
  });
  return skipped.count === 1;
}

/**
 * Похожие лиды — третий уровень.
 *
 * Оператор `%` стоит рядом с явным `similarity() >` намеренно: индекс по
 * триграммам работает только с `%`, а его порог живёт в переменной сессии
 * (`pg_trgm.similarity_threshold`, по умолчанию 0.3). Через PgBouncer в
 * transaction mode настройка сессии ненадёжна, поэтому `%` отбирает грубо и
 * по индексу, а точный порог накладывается вторым условием.
 *
 * Город сравнивается, только если он известен обеим сторонам: у лида с сайта
 * города часто нет, и требовать совпадения значило бы пропустить дубль.
 */
export async function findSimilarLeads(
  name: string,
  city: string | null,
): Promise<SimilarLead[]> {
  const rows = await prisma.$queryRaw<
    Array<{ id: string; name: string; city: string | null; similarity: number }>
  >`
    SELECT id, name, city, similarity(name, ${name}) AS similarity
    FROM "Lead"
    WHERE name % ${name}
      AND similarity(name, ${name}) > ${SIMILARITY_THRESHOLD}
      AND (
        ${city}::text IS NULL
        OR city IS NULL
        OR lower(city) = lower(${city}::text)
      )
    ORDER BY similarity DESC
    LIMIT ${SIMILAR_LIMIT}
  `;

  return rows.map((r) => ({
    leadId: r.id,
    name: r.name,
    city: r.city,
    similarity: Number(r.similarity),
  }));
}

/**
 * Дописать лиду только то, чего у него НЕТ.
 *
 * Именно «только пустое», а не «всё, что пришло»: у справочника бывает старый
 * адрес, а владелец мог поправить название и город руками. Затирать правку
 * автоматикой значит терять её молча — а замечают такое через месяц, когда
 * восстанавливать уже нечего.
 */
async function fillEmptyFields(
  leadId: string,
  candidate: { city: string | null; site: string | null; address: string | null },
): Promise<void> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { city: true, site: true, address: true },
  });
  if (!lead) return;

  await prisma.lead.update({
    where: { id: leadId },
    data: {
      city: lead.city ? undefined : (candidate.city ?? undefined),
      site: lead.site ? undefined : (candidate.site ?? undefined),
      address: lead.address ? undefined : (candidate.address ?? undefined),
    },
  });
}

async function markImported(candidateId: string, leadId: string): Promise<void> {
  await prisma.parsedCompany.update({
    where: { id: candidateId },
    data: { status: "IMPORTED", leadId },
  });
}
