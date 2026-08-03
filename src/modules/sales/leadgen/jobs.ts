import type { LeadNiche, ParseJobStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/core/db";
import { logInfo } from "@/core/observability/logger";
import { connectorById, type ConnectorId } from "../connectors";
import { PipelineError } from "../pipeline";

/**
 * Заявки на прогон лидогена.
 *
 * Джоба — это «найди автосервисы в Екатеринбурге», а не «сделай один запрос к
 * API». Разница существенна: город целиком не помещается ни в одну выдачу и
 * почти наверняка не помещается в суточный кап бесплатного тира. Поэтому
 * джоба живёт днями, а исполняется по странице за тик крона.
 */

export interface ParseJobStats {
  pages: number;
  requestsUsed: number;
  found: number;
  stored: number;
  duplicates: number;
}

export const EMPTY_STATS: ParseJobStats = {
  pages: 0,
  requestsUsed: 0,
  found: 0,
  stored: 0,
  duplicates: 0,
};

const StatsShape = z.object({
  pages: z.number().int().min(0),
  requestsUsed: z.number().int().min(0),
  found: z.number().int().min(0),
  stored: z.number().int().min(0),
  duplicates: z.number().int().min(0),
});

/**
 * Статистика читается терпимо: формат мог поменяться между деплоями, а
 * уронить крон из-за поля в счётчике — цена, несопоставимая с пользой.
 */
export function readStats(raw: unknown): ParseJobStats {
  const parsed = StatsShape.safeParse(raw);
  return parsed.success ? parsed.data : { ...EMPTY_STATS };
}

export function addStats(base: ParseJobStats, delta: Partial<ParseJobStats>): ParseJobStats {
  return {
    pages: base.pages + (delta.pages ?? 0),
    requestsUsed: base.requestsUsed + (delta.requestsUsed ?? 0),
    found: base.found + (delta.found ?? 0),
    stored: base.stored + (delta.stored ?? 0),
    duplicates: base.duplicates + (delta.duplicates ?? 0),
  };
}

export interface CreateParseJobInput {
  connector: ConnectorId;
  rubric: string;
  city: string;
  niche?: LeadNiche;
}

export async function createParseJob(input: CreateParseJobInput): Promise<{ jobId: string }> {
  const rubric = input.rubric.trim();
  const city = input.city.trim();
  if (rubric.length === 0 || city.length === 0) {
    throw new PipelineError("Нужны и рубрика, и город.", "input");
  }

  const connector = connectorById(input.connector);
  if (!connector) throw new PipelineError("Такого источника нет.", "not_found");
  if (!connector.isConfigured()) {
    // Отказ до создания, а не молчаливая джоба, которая никогда не сдвинется:
    // «висит в ожидании» и «нет ключа» выглядят одинаково, а чинятся по-разному.
    throw new PipelineError(`Источник «${connector.label}» не настроен.`, "state");
  }

  // Тот же запрос, уже идущий, — не повод заводить второй: они поделили бы
  // суточный кап пополам и оба не дошли бы до конца.
  const running = await prisma.parseJob.findFirst({
    where: { connector: input.connector, rubric, city, status: { in: ["PENDING", "RUNNING"] } },
    select: { id: true },
  });
  if (running) throw new PipelineError("Такой прогон уже идёт.", "state");

  const job = await prisma.parseJob.create({
    data: {
      connector: input.connector,
      rubric,
      city,
      niche: input.niche ?? "AUTO_SERVICE",
      stats: { ...EMPTY_STATS },
    },
    select: { id: true },
  });

  logInfo("sales.parse_job_created", { jobId: job.id, connector: input.connector, city });
  return { jobId: job.id };
}

/** Остановить прогон. Уже собранные кандидаты остаются: они не виноваты. */
export async function cancelParseJob(jobId: string): Promise<boolean> {
  const stopped = await prisma.parseJob.updateMany({
    where: { id: jobId, status: { in: ["PENDING", "RUNNING"] } },
    data: { status: "CANCELLED", finishedAt: new Date(), lockedAt: null },
  });
  return stopped.count === 1;
}

export interface ParseJobView {
  id: string;
  connector: string;
  rubric: string;
  city: string;
  status: ParseJobStatus;
  stats: ParseJobStats;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export async function listParseJobs(limit = 20): Promise<ParseJobView[]> {
  const jobs = await prisma.parseJob.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      connector: true,
      rubric: true,
      city: true,
      status: true,
      stats: true,
      error: true,
      createdAt: true,
      finishedAt: true,
    },
  });

  return jobs.map((j) => ({
    id: j.id,
    connector: j.connector,
    rubric: j.rubric,
    city: j.city,
    status: j.status,
    stats: readStats(j.stats),
    error: j.error,
    createdAt: j.createdAt.toISOString(),
    finishedAt: j.finishedAt?.toISOString() ?? null,
  }));
}
