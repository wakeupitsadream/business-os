import { dayBounds, dayKey, monthBounds, periodKey, weekBounds, yearBounds } from "@/core/shared/time";

/**
 * Периоды финансовых запросов.
 *
 * Названные периоды считает КОД, а не модель. Модель, спрошенная «сколько ушло
 * на рекламу в июле», охотно присылает границы месяца в UTC — и операция от
 * 1 июля 02:00 местного уезжает в июнь, а итог не сходится с выпиской. Здесь
 * границы режутся по суткам владельца, как и всё остальное в системе.
 *
 * Произвольный диапазон модель всё-таки может задать (from/to), но это
 * запасной путь: для «за июль», «за прошлый месяц», «с начала года» она
 * обязана назвать период именем.
 */

export const PERIOD_NAMES = [
  "today",
  "yesterday",
  "week",
  "prev_week",
  "month",
  "prev_month",
  "quarter",
  "year",
  "all",
] as const;

export type PeriodName = (typeof PERIOD_NAMES)[number];

export interface Range {
  start: Date;
  end: Date;
  label: string;
}

const MONTHS = [
  "январь",
  "февраль",
  "март",
  "апрель",
  "май",
  "июнь",
  "июль",
  "август",
  "сентябрь",
  "октябрь",
  "ноябрь",
  "декабрь",
];

/** Начало учёта: раньше этой даты операций быть не может. */
const EPOCH = new Date("2020-01-01T00:00:00.000Z");

export function resolvePeriod(name: PeriodName, now: Date): Range {
  switch (name) {
    case "today": {
      const { start, end } = dayBounds(now);
      return { start, end, label: "сегодня" };
    }
    case "yesterday": {
      const { start } = dayBounds(now);
      const prev = dayBounds(new Date(start.getTime() - 1));
      return { start: prev.start, end: prev.end, label: "вчера" };
    }
    case "week": {
      const { start, end } = weekBounds(now);
      return { start, end, label: "текущая неделя" };
    }
    case "prev_week": {
      const { start } = weekBounds(now);
      const prev = weekBounds(new Date(start.getTime() - 1));
      return { start: prev.start, end: prev.end, label: "прошлая неделя" };
    }
    case "month": {
      const { start, end } = monthBounds(now);
      return { start, end, label: monthLabel(start) };
    }
    case "prev_month": {
      // Миллисекунда до начала текущего месяца гарантированно лежит в
      // предыдущем — включая декабрь, где наивное «месяц − 1» ломает год.
      const { start } = monthBounds(now);
      const prev = monthBounds(new Date(start.getTime() - 1));
      return { start: prev.start, end: prev.end, label: monthLabel(prev.start) };
    }
    case "quarter": {
      const { end } = monthBounds(now);
      let cursor = monthBounds(now).start;
      for (let i = 0; i < 2; i += 1) cursor = monthBounds(new Date(cursor.getTime() - 1)).start;
      return { start: cursor, end, label: "последние 3 месяца" };
    }
    case "year": {
      const { start, end } = yearBounds(now);
      return { start, end, label: `${dayKey(start).slice(0, 4)} год` };
    }
    case "all":
      return { start: EPOCH, end: new Date(now.getTime() + 1), label: "всё время" };
  }
}

function monthLabel(start: Date): string {
  // start — граница месяца по поясу владельца, выраженная в UTC (для UTC+5 это
  // 19:00 предыдущего дня). Ярлык обязан читаться по времени владельца, иначе
  // июль подписывался бы как июнь.
  const [year, month] = periodKey(start).split("-");
  return `${MONTHS[Number(month) - 1] ?? month} ${year}`;
}

/** Явный диапазон от модели. Обе границы обязательны, конец включает свой день. */
export function explicitRange(from: string, to: string): Range | null {
  const start = new Date(from);
  const rawEnd = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(rawEnd.getTime())) return null;
  if (rawEnd.getTime() < start.getTime()) return null;

  // Модель присылает «по 31 июля», подразумевая включительно, — берём конец
  // этих суток по владельцу, иначе последний день молча выпадает из отчёта.
  const end = dayBounds(rawEnd).end;
  return { start, end, label: `${from} — ${to}` };
}
