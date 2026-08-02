import { describe, expect, it } from "vitest";
import { resetReminderCursor, setEarliestReminder, shouldCheckReminders } from "@/modules/secretary/reminder-cursor";

/**
 * Сколько раз в сутки система будит компьют Neon, ничего при этом не делая.
 *
 * Это не микрооптимизация. Лимит бесплатного тарифа — 100 CU-часов в месяц,
 * ОБЩИХ с Agentus, а каждое изолированное пробуждение стоит около пяти минут
 * компьюта независимо от того, был это тяжёлый отчёт или `SELECT 1`. Поэтому
 * платят не за работу, а за КОЛИЧЕСТВО РАЗБУЖЕНИЙ — и считать надо именно его.
 *
 * Тест закрепляет результат: при нулевой активности владельца самопроверок в
 * сутки — единицы, а не десятки.
 */

/** Минут компьюта за одно изолированное пробуждение (тариф Neon). */
const WAKE_MINUTES = 5;

function selfChecksPerDay(): { resync: number; heartbeat: number } {
  resetReminderCursor();
  const start = new Date("2026-08-01T00:00:00Z").getTime();
  setEarliestReminder(null, new Date(start));

  let resync = 0;
  for (let minute = 1; minute <= 24 * 60; minute += 1) {
    const tick = new Date(start + minute * 60_000);
    if (shouldCheckReminders(tick)) {
      resync += 1;
      setEarliestReminder(null, tick);
    }
  }
  // Пульс: одна запись в сутки (см. heartbeat.test.ts).
  return { resync, heartbeat: 1 };
}

describe("бюджет компьюта при нулевой активности", () => {
  it("самопроверок в сутки — единицы", () => {
    const { resync, heartbeat } = selfChecksPerDay();

    expect(resync).toBe(4);
    expect(heartbeat).toBe(1);
    // Было 48 — по 24 на каждую часовую сетку.
    expect(resync + heartbeat).toBeLessThanOrEqual(5);
  });

  it("месячный расход самопроверок укладывается в единицы CU-часов", () => {
    const { resync, heartbeat } = selfChecksPerDay();
    const hoursPerMonth = ((resync + heartbeat) * WAKE_MINUTES * 30) / 60;

    // Было около 120 часов в месяц — треть общего лимита, потраченная ни на что.
    expect(hoursPerMonth).toBeLessThan(15);
  });
});
