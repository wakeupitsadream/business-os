import { Prisma } from "@prisma/client";
import { prisma } from "@/core/db";
import { markPendingWork } from "@/core/cron/pending-work";
import { logInfo, logWarn } from "@/core/observability/logger";
import { ConnectorError, connectorById, type ParsedCompany } from "../connectors";
import { normalizePhone } from "../phone";
import { addStats, readStats, type ParseJobStats } from "./jobs";

/**
 * Исполнитель прогонов лидогена: одна джоба за тик крона.
 *
 * Почему одна. Суточный кап бесплатного тира меньше, чем компаний в городе, и
 * тик, который жадно вычерпывает квоту, оставляет остальные джобы стоять до
 * завтра. По странице за раз работа идёт медленно, зато идёт у всех.
 *
 * **Блокировка — отметкой в строке, а не advisory lock.** Приложение ходит в
 * базу через PgBouncer в transaction mode, где сессионная блокировка не
 * переживает границу транзакции, а держать транзакцию открытой на время
 * похода в чужой API нельзя тем более. Поэтому джоба забирается атомарным
 * UPDATE по условию — тем же приёмом, что и партия импорта выписки, — а
 * протухшая отметка (контейнер умер посреди тика) отдаёт джобу следующему.
 *
 * Курсор пишется ПОСЛЕ каждой страницы. Записать в конце значило бы потерять
 * всю работу тика при любом сбое — и, что хуже, потратить квоту зря.
 */

/** Через сколько отметка «в работе» считается протухшей. */
const LOCK_TTL_MS = 10 * 60 * 1000;

/** Сколько страниц берём за тик. Больше — жаднее к квоте, см. шапку. */
const PAGES_PER_TICK = 3;

const PAGE_SIZE = 50;

/** Курсор для записи: `null` в JSON-колонке Prisma — это `DbNull`, не `null`. */
function cursorField(cursor: Record<string, unknown> | null) {
  return cursor === null ? Prisma.DbNull : (cursor as Prisma.InputJsonObject);
}

export interface ParseTickResult {
  ok: boolean;
  detail: string;
  /** true — очередь пуста, тик не сделал ничего: курсору можно спать. */
  idle?: boolean;
  jobId?: string;
  stats?: ParseJobStats;
}

export async function runParseTick(now: Date = new Date()): Promise<ParseTickResult> {
  const job = await claimJob(now);
  if (!job) return { ok: true, detail: "нет прогонов в очереди", idle: true };

  const connector = connectorById(job.connector as never);
  if (!connector || !connector.isConfigured()) {
    // Ключ мог исчезнуть между созданием джобы и тиком. Это чинится
    // переменной окружения, а не пересозданием прогона, поэтому возвращаем
    // джобу в очередь, а не хороним её как упавшую.
    await release(job.id);
    logWarn("sales.parse_connector_unavailable", { jobId: job.id, connector: job.connector });
    return { ok: true, detail: `источник «${job.connector}» не настроен — прогон ждёт`, jobId: job.id };
  }

  let stats = readStats(job.stats);
  let cursor = (job.cursor ?? null) as Record<string, unknown> | null;

  for (let page = 0; page < PAGES_PER_TICK; page += 1) {
    let result;
    try {
      result = await connector.search({
        rubric: job.rubric,
        city: job.city,
        pageSize: PAGE_SIZE,
        cursor,
      });
    } catch (e) {
      if (e instanceof ConnectorError && e.kind === "quota") {
        // Квота — не поломка, а расписание. Джоба возвращается в очередь и
        // продолжится с того же курсора, когда кап отпустит.
        await release(job.id, stats, cursor);
        logInfo("sales.parse_quota_pause", { jobId: job.id, ...stats });
        return { ok: true, detail: e.message, jobId: job.id, stats };
      }

      const message = e instanceof Error ? e.message : String(e);
      await fail(job.id, message, stats, cursor);
      logWarn("sales.parse_failed", { jobId: job.id, error: message });
      return { ok: false, detail: message, jobId: job.id, stats };
    }

    const saved = await storeCompanies(job.id, job.niche, result.companies);
    stats = addStats(stats, {
      pages: 1,
      requestsUsed: result.requestsUsed,
      found: result.companies.length,
      stored: saved.stored,
      duplicates: saved.duplicates,
    });
    cursor = result.nextCursor;

    // Курсор и счётчики фиксируются после КАЖДОЙ страницы — см. шапку.
    await prisma.parseJob.update({
      where: { id: job.id },
      data: { cursor: cursorField(cursor), stats: { ...stats }, lockedAt: new Date() },
    });

    if (!cursor) {
      await prisma.parseJob.update({
        where: { id: job.id },
        data: { status: "DONE", finishedAt: new Date(), lockedAt: null },
      });
      logInfo("sales.parse_done", { jobId: job.id, ...stats });
      return { ok: true, detail: `прогон завершён: ${stats.stored} новых`, jobId: job.id, stats };
    }
  }

  await release(job.id, stats, cursor);
  logInfo("sales.parse_page", { jobId: job.id, ...stats });
  return { ok: true, detail: `страниц за тик: ${PAGES_PER_TICK}`, jobId: job.id, stats };
}

interface ClaimedJob {
  id: string;
  connector: string;
  rubric: string;
  city: string;
  niche: ParsedCompany["niche"];
  cursor: unknown;
  stats: unknown;
}

/**
 * Забрать одну джобу.
 *
 * Условие UPDATE включает наблюдённые `status` и `lockedAt` — это
 * compare-and-swap: два контейнера, увидевшие одну протухшую джобу, оба
 * попробуют её забрать, но обновится строка ровно у одного.
 */
async function claimJob(now: Date): Promise<ClaimedJob | null> {
  const stale = new Date(now.getTime() - LOCK_TTL_MS);

  const candidates = await prisma.parseJob.findMany({
    where: {
      OR: [{ status: "PENDING" }, { status: "RUNNING", lockedAt: { lt: stale } }],
    },
    orderBy: { createdAt: "asc" },
    take: 5,
    select: {
      id: true,
      status: true,
      lockedAt: true,
      connector: true,
      rubric: true,
      city: true,
      niche: true,
      cursor: true,
      stats: true,
      startedAt: true,
    },
  });

  for (const candidate of candidates) {
    const claimed = await prisma.parseJob.updateMany({
      where: { id: candidate.id, status: candidate.status, lockedAt: candidate.lockedAt },
      data: {
        status: "RUNNING",
        lockedAt: now,
        startedAt: candidate.startedAt ?? now,
        error: null,
      },
    });
    if (claimed.count === 1) return candidate;
  }

  return null;
}

async function release(
  jobId: string,
  stats?: ParseJobStats,
  cursor?: Record<string, unknown> | null,
): Promise<void> {
  await prisma.parseJob.update({
    where: { id: jobId },
    data: {
      status: "PENDING",
      lockedAt: null,
      ...(stats ? { stats: { ...stats } } : {}),
      ...(cursor !== undefined ? { cursor: cursorField(cursor) } : {}),
    },
  });
}

async function fail(
  jobId: string,
  error: string,
  stats: ParseJobStats,
  cursor: Record<string, unknown> | null,
): Promise<void> {
  await prisma.parseJob.update({
    where: { id: jobId },
    data: {
      status: "FAILED",
      error: error.slice(0, 500),
      finishedAt: new Date(),
      lockedAt: null,
      stats: { ...stats },
      cursor: cursorField(cursor),
    },
  });
}

/**
 * Сохранить страницу выдачи.
 *
 * Первый уровень дедупа — уникальный `[source, externalId]`. Повторная встреча
 * обновляет ТОЛЬКО факты источника: рейтинг мог измениться, а решение
 * владельца («пропустил», «завёл лид») и оценка ИИ — нет. Затирать их
 * обновлением значило бы каждую ночь возвращать в список отвергнутое.
 */
async function storeCompanies(
  jobId: string,
  niche: ParsedCompany["niche"],
  companies: ParsedCompany[],
): Promise<{ stored: number; duplicates: number }> {
  if (companies.length === 0) return { stored: 0, duplicates: 0 };

  // Внутри одной страницы источник тоже способен повториться.
  const unique = new Map<string, ParsedCompany>();
  for (const company of companies) unique.set(`${company.source}:${company.externalId}`, company);

  let stored = 0;
  let duplicates = 0;

  for (const company of unique.values()) {
    const facts = {
      name: company.name,
      city: company.city,
      address: company.address,
      phones: company.phones,
      phoneNormalized: firstNormalizedPhone(company.phones),
      site: company.site,
      rating: company.rating,
      reviewsCount: company.reviewsCount,
      raw: (company.raw ?? null) as Prisma.InputJsonValue,
    };

    const existing = await prisma.parsedCompany.findUnique({
      where: { source_externalId: { source: company.source, externalId: company.externalId } },
      select: { id: true },
    });

    if (existing) {
      await prisma.parsedCompany.update({ where: { id: existing.id }, data: facts });
      duplicates += 1;
      continue;
    }

    try {
      await prisma.parsedCompany.create({
        data: {
          jobId,
          source: company.source,
          externalId: company.externalId,
          niche: company.niche === "OTHER" ? niche : company.niche,
          isPersonalData: company.isPersonalData,
          ...facts,
        },
      });
      // Появился кандидат — курсору скоринга есть что оценивать. В памяти,
      // потому что скоринг живёт в этом же процессе.
      markPendingWork("scoring");
      stored += 1;
    } catch {
      // Строку создал параллельный тик между проверкой и вставкой — это и
      // есть дубль, ради которого уникальный индекс поставлен.
      duplicates += 1;
    }
  }

  return { stored, duplicates };
}

/**
 * Первый разобранный номер.
 *
 * Источник отдаёт и мобильные, и городские, и куски вроде «доб. 102».
 * `normalizePhone` возвращает null на всём, что не похоже на телефон, — берём
 * первый, который прошёл: мусорный ключ дедупа хуже отсутствующего.
 */
export function firstNormalizedPhone(phones: string[]): string | null {
  for (const phone of phones) {
    const normalized = normalizePhone(phone);
    if (normalized) return normalized;
  }
  return null;
}
