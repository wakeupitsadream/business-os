import { dayBounds } from "@/core/shared/time";

/**
 * Сколько дней подряд закрывалась хотя бы одна задача.
 *
 * Считается от сегодня назад и обрывается на первом пустом дне. Пустое
 * «сегодня» серию не рвёт: день ещё идёт, и обнулять счётчик в девять утра —
 * верный способ научить владельца на него не смотреть. Маленькая цифра, но
 * если она врёт, вместе с ней перестаёт работать вся мягкая мотивация.
 *
 * Границы дней — по времени владельца, а не по UTC.
 */
export function countStreak(completedAt: Date[], now: Date = new Date()): number {
  if (completedAt.length === 0) return 0;

  const days = new Set(completedAt.map((d) => dayBounds(d).start.getTime()));
  const DAY = 24 * 3600 * 1000;

  let cursor = dayBounds(now).start.getTime();
  if (!days.has(cursor)) cursor -= DAY;

  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor -= DAY;
  }
  return streak;
}
