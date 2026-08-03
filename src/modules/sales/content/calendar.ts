import { prisma } from "@/core/db";
import { OWNER_TZ, dayKey, monthBounds } from "@/core/shared/time";
import { TZDate } from "@date-fns/tz";
import type { CalendarDay, CalendarPost } from "@/components/sales/content-calendar";

/**
 * Сетка календаря.
 *
 * Считается на СЕРВЕРЕ, потому что в клиентской сборке `OWNER_TZ` из окружения
 * не читается и молча становится значением по умолчанию: сетка, построенная в
 * браузере, поехала бы на границе суток.
 */

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

/** Месяц в виде шести недель: сетка не прыгает по высоте от месяца к месяцу. */
const WEEKS = 6;

export interface CalendarView {
  weekdays: string[];
  days: CalendarDay[];
  /** "2026-08" — для ссылок «назад» и «вперёд». */
  monthKey: string;
  monthLabel: string;
  prevKey: string;
  nextKey: string;
}

const MONTHS = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

function shiftMonth(year: number, month: number, delta: number): string {
  const d = new Date(Date.UTC(year, month + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Разбор ?at=YYYY-MM. Мусор молча превращается в текущий месяц. */
export function parseMonthKey(raw: string | undefined, now: Date, tz: string = OWNER_TZ): Date {
  const match = raw ? /^(\d{4})-(\d{2})$/.exec(raw) : null;
  if (!match) return now;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  if (month < 0 || month > 11) return now;
  return new Date(new TZDate(year, month, 1, 12, 0, 0, 0, tz).getTime());
}

export async function loadCalendar(
  at: Date = new Date(),
  now: Date = new Date(),
  tz: string = OWNER_TZ,
): Promise<CalendarView> {
  const local = new TZDate(at, tz);
  const year = local.getFullYear();
  const month = local.getMonth();

  const { start: monthStart } = monthBounds(at, tz);
  const firstLocal = new TZDate(monthStart, tz);

  // Сетка начинается с понедельника недели, в которую попало первое число.
  const leading = (firstLocal.getDay() + 6) % 7;
  const gridStartLocal = new TZDate(year, month, 1 - leading, 0, 0, 0, 0, tz);
  const gridStart = new Date(gridStartLocal.getTime());
  const gridEndLocal = new TZDate(year, month, 1 - leading + WEEKS * 7, 0, 0, 0, 0, tz);
  const gridEnd = new Date(gridEndLocal.getTime());

  const posts = await prisma.contentPost.findMany({
    where: { scheduledAt: { gte: gridStart, lt: gridEnd } },
    orderBy: { scheduledAt: "asc" },
    // Явный select обязателен: `media` — это байты картинки, и месяц постов
    // утащил бы в память десятки мегабайт на каждый рендер.
    select: {
      id: true,
      title: true,
      rubric: true,
      status: true,
      degraded: true,
      scheduledAt: true,
    },
  });

  const byDay = new Map<string, CalendarPost[]>();
  for (const p of posts) {
    if (!p.scheduledAt) continue;
    const key = dayKey(p.scheduledAt, tz);
    const localAt = new TZDate(p.scheduledAt, tz);
    const timeLabel = `${String(localAt.getHours()).padStart(2, "0")}:${String(localAt.getMinutes()).padStart(2, "0")}`;
    const list = byDay.get(key) ?? [];
    list.push({
      id: p.id,
      title: p.title,
      rubric: p.rubric,
      status: p.status,
      degraded: p.degraded,
      timeLabel,
    });
    byDay.set(key, list);
  }

  const todayKey = dayKey(now, tz);
  const days: CalendarDay[] = [];
  for (let i = 0; i < WEEKS * 7; i += 1) {
    const cellLocal = new TZDate(year, month, 1 - leading + i, 12, 0, 0, 0, tz);
    const cell = new Date(cellLocal.getTime());
    const key = dayKey(cell, tz);
    days.push({
      key,
      dayNumber: cellLocal.getDate(),
      isToday: key === todayKey,
      inCurrentMonth: cellLocal.getMonth() === month,
      posts: byDay.get(key) ?? [],
    });
  }

  return {
    weekdays: WEEKDAYS,
    days,
    monthKey: `${year}-${String(month + 1).padStart(2, "0")}`,
    monthLabel: `${MONTHS[month] ?? ""} ${year}`,
    prevKey: shiftMonth(year, month, -1),
    nextKey: shiftMonth(year, month, 1),
  };
}

/**
 * Сколько постов ждут решения владельца.
 *
 * Выносится бейджем на экран продаж: пост с неизвестным исходом — это
 * единственное состояние, из которого система не выходит сама, и висеть
 * незамеченным оно не должно.
 */
export async function countUncertainPosts(): Promise<number> {
  return prisma.contentPost.count({ where: { status: "UNCERTAIN" } });
}
