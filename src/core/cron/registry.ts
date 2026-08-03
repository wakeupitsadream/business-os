/**
 * Реестр фоновых задач: единственное место, где имя джобы связывается с кодом.
 *
 * Роут `/api/cron/[job]` не знает про конкретные задачи — он только ищет
 * обработчик здесь. Добавить задачу = дописать строку в CRON_HANDLERS и
 * расписание в scripts/start-container.mjs (расписание живёт в планировщике
 * контейнера, потому что кроны хостинга на Timeweb нам недоступны).
 */

import {
  candidateScoring,
  cleanupDedup,
  dailyBrief,
  daySummary,
  eveningCheckin,
  financeInsights,
  heartbeat,
  importCleanup,
  outreachDrafts,
  parseRunner,
  reminders,
  yookassaSync,
} from "@/core/cron/jobs";

export interface CronJobHandler {
  (): Promise<{ ok: boolean; detail?: string }>;
}

export const CRON_HANDLERS: Record<string, CronJobHandler> = {
  heartbeat,
  reminders,
  "daily-brief": dailyBrief,
  "evening-checkin": eveningCheckin,
  "day-summary": daySummary,
  "cleanup-dedup": cleanupDedup,
  "cleanup-imports": importCleanup,
  "yookassa-sync": yookassaSync,
  "finance-insights": financeInsights,
  "parse-runner": parseRunner,
  "candidate-scoring": candidateScoring,
  "outreach-drafts": outreachDrafts,
};

/** Имена всех известных задач — для health, диагностики и тестов. */
export const CRON_JOB_NAMES: string[] = Object.keys(CRON_HANDLERS);

/**
 * Безопасный поиск обработчика. Отдельная функция, а не прямое обращение к
 * объекту: имя джобы приходит из URL, и `CRON_HANDLERS[job]` для чужого ключа
 * вроде "constructor" вернул бы функцию из прототипа.
 */
export function getCronHandler(job: string): CronJobHandler | undefined {
  if (!Object.hasOwn(CRON_HANDLERS, job)) return undefined;
  return CRON_HANDLERS[job];
}
