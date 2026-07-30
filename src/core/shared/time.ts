import { TZDate } from "@date-fns/tz";

/**
 * Время в системе: хранение — UTC, бизнес-периоды — Europe/Moscow.
 *
 * Это не педантизм: «вчерашние финансы» в утреннем брифе и месячные отчёты
 * режутся по московским суткам. Операция в 02:00 МСК 1 августа по UTC ещё
 * июльская — без явной таймзоны она попала бы не в тот месяц и итог не сошёлся
 * бы с банковской выпиской.
 */

export const OWNER_TZ = "Europe/Moscow";

/** Ключ периода для агрегатов и дедупа инсайтов: "2026-07". */
export function periodKey(date: Date, tz: string = OWNER_TZ): string {
  const local = new TZDate(date, tz);
  const month = String(local.getMonth() + 1).padStart(2, "0");
  return `${local.getFullYear()}-${month}`;
}

/** Ключ дня: "2026-07-29". Используется для идемпотентности суточных джоб. */
export function dayKey(date: Date, tz: string = OWNER_TZ): string {
  const local = new TZDate(date, tz);
  const month = String(local.getMonth() + 1).padStart(2, "0");
  const day = String(local.getDate()).padStart(2, "0");
  return `${local.getFullYear()}-${month}-${day}`;
}

/** Границы локальных суток в UTC — для запросов `date >= start AND date < end`. */
export function dayBounds(date: Date, tz: string = OWNER_TZ): { start: Date; end: Date } {
  const local = new TZDate(date, tz);
  const start = new TZDate(local.getFullYear(), local.getMonth(), local.getDate(), 0, 0, 0, 0, tz);
  const end = new TZDate(local.getFullYear(), local.getMonth(), local.getDate() + 1, 0, 0, 0, 0, tz);
  return { start: new Date(start.getTime()), end: new Date(end.getTime()) };
}

/** Границы локального месяца в UTC. */
export function monthBounds(date: Date, tz: string = OWNER_TZ): { start: Date; end: Date } {
  const local = new TZDate(date, tz);
  const start = new TZDate(local.getFullYear(), local.getMonth(), 1, 0, 0, 0, 0, tz);
  const end = new TZDate(local.getFullYear(), local.getMonth() + 1, 1, 0, 0, 0, 0, tz);
  return { start: new Date(start.getTime()), end: new Date(end.getTime()) };
}

/** Локальное время владельца как {hour, minute} — для расписаний и брифов. */
export function localTimeParts(date: Date, tz: string = OWNER_TZ): { hour: number; minute: number } {
  const local = new TZDate(date, tz);
  return { hour: local.getHours(), minute: local.getMinutes() };
}

export function formatLocal(date: Date, tz: string = OWNER_TZ): string {
  const local = new TZDate(date, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(local.getDate())}.${pad(local.getMonth() + 1)}.${local.getFullYear()} ${pad(local.getHours())}:${pad(local.getMinutes())}`;
}
