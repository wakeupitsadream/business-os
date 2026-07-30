import type { CheckInKind } from "@prisma/client";
import { prisma } from "@/core/db";
import { logInfo } from "@/core/observability/logger";
import { dayBounds, OWNER_TZ } from "@/core/shared/time";
import { TZDate } from "@date-fns/tz";

/**
 * Чек-ины состояния владельца.
 *
 * Смысл не в самих цифрах, а в том, что секретарь перестаёт быть слепым:
 * зная, что энергия третий день на двойке, он не станет предлагать «добить
 * ещё две задачи» — и это тот случай, когда система приносит пользу, ничего
 * не делая.
 */

/**
 * Дата чек-ина — ЛОКАЛЬНАЯ дата владельца, приведённая к полуночи UTC.
 *
 * Колонка объявлена как `@db.Date`, и записывать в неё «сейчас» нельзя:
 * вечерний чек-ин в 23:30 МСК по UTC уже относится к следующим суткам, и
 * защита от повторного чек-ина за день перестала бы работать ровно в те часы,
 * когда чек-ины и делаются.
 */
export function checkInDate(now: Date, tz: string = OWNER_TZ): Date {
  const local = new TZDate(now, tz);
  return new Date(
    Date.UTC(local.getFullYear(), local.getMonth(), local.getDate(), 0, 0, 0, 0),
  );
}

export interface CheckInInput {
  mood?: number;
  energy?: number;
  stress?: number;
  note?: string;
  kind?: CheckInKind;
  now?: Date;
}

/**
 * Записать или дополнить чек-ин за день.
 *
 * Именно дополнить: настроение и энергия приходят двумя нажатиями кнопок с
 * разницей в секунды, и второе не должно затирать первое.
 */
export async function upsertCheckIn(input: CheckInInput) {
  const now = input.now ?? new Date();
  const date = checkInDate(now);
  const kind = input.kind ?? "EVENING";

  const patch = {
    ...(input.mood !== undefined ? { mood: clamp(input.mood) } : {}),
    ...(input.energy !== undefined ? { energy: clamp(input.energy) } : {}),
    ...(input.stress !== undefined ? { stress: clamp(input.stress) } : {}),
    ...(input.note !== undefined ? { note: input.note.trim() || null } : {}),
  };

  const saved = await prisma.checkIn.upsert({
    where: { date_kind: { date, kind } },
    update: patch,
    create: { date, kind, ...patch },
  });

  logInfo("checkin.saved", { kind, mood: saved.mood, energy: saved.energy });
  return saved;
}

/** Есть ли уже чек-ин за сегодня — чтобы вечерний крон не спрашивал дважды. */
export async function hasCheckInToday(now: Date = new Date()): Promise<boolean> {
  const found = await prisma.checkIn.findFirst({
    where: { date: checkInDate(now) },
    select: { id: true },
  });
  return found !== null;
}

/** Последний чек-ин — для системного промпта и брифа. */
export async function latestCheckIn() {
  return prisma.checkIn.findFirst({
    orderBy: { date: "desc" },
    select: { date: true, kind: true, mood: true, energy: true, stress: true, note: true },
  });
}

/**
 * Динамика за последние дни — по ней видно не разовый провал, а тенденцию.
 * Именно тенденция важна: один тяжёлый день ничего не значит, пять подряд —
 * значат.
 */
export async function recentCheckIns(days = 7, now: Date = new Date()) {
  const { start } = dayBounds(new Date(now.getTime() - (days - 1) * 24 * 3600 * 1000));
  return prisma.checkIn.findMany({
    where: { date: { gte: start } },
    orderBy: { date: "asc" },
    select: { date: true, mood: true, energy: true },
  });
}

/**
 * Признак затяжного спада: несколько дней подряд с низкой энергией или
 * настроением. Это сигнал секретарю снизить нагрузку, а не наращивать её.
 */
export async function isInSlump(now: Date = new Date()): Promise<boolean> {
  const rows = await recentCheckIns(5, now);
  const scored = rows.filter((r) => r.mood !== null || r.energy !== null);
  if (scored.length < 3) return false;

  const low = scored.filter((r) => (r.mood ?? 5) <= 2 || (r.energy ?? 5) <= 2);
  return low.length >= 3;
}

function clamp(value: number): number {
  return Math.min(5, Math.max(1, Math.round(value)));
}
