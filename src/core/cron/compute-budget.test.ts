import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resetReminderCursor, setEarliestReminder, shouldCheckReminders } from "@/modules/secretary/reminder-cursor";
import {
  beginWorkPoll,
  completeWorkPoll,
  resetPendingWork,
  shouldPollWork,
} from "./pending-work";

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

describe("ночной бэкап не добавляет пробуждения", () => {
  it("backup-db стоит ровно в минуте суточной границы, где компьют и так проснётся", () => {
    // Границы шестичасовой сетки resync — 00/06/12/18 UTC ровно в :00, и в ту
    // же первую минуту суток пишется пульс. Любое другое время в расписании —
    // это плюс одно оплаченное пробуждение в сутки на ровном месте.
    const source = readFileSync(
      new URL("../../../scripts/start-container.mjs", import.meta.url),
      "utf8",
    );
    const m = /\{ job: "backup-db", hourUtc: (\d+), minute: (\d+) \}/.exec(source);
    expect(m, "backup-db не найден в планировщике").toBeTruthy();
    expect(Number(m![1]) % 6).toBe(0);
    expect(Number(m![2])).toBe(0);
  });
});

describe("тихие сутки всей системы", () => {
  it("все курсоры вместе будят компьют четыре раза, и все — в общих минутах", () => {
    // Полная симуляция суток без активности владельца: минутный крон
    // напоминаний, parse-runner каждые 15 минут, candidate-scoring каждые 30.
    // Сетки у всех одни (шесть часов от полуночи UTC), поэтому страховочные
    // сверки сходятся в одни и те же минуты — и оплачиваются одним
    // пробуждением, а не тремя. Пульс и ночной бэкап стоят в минуте 00:00,
    // которая уже в наборе.
    resetReminderCursor();
    resetPendingWork();
    const start = Date.UTC(2026, 7, 1); // полночь UTC

    setEarliestReminder(null, new Date(start));
    completeWorkPoll("parse", beginWorkPoll("parse"), false, new Date(start));
    completeWorkPoll("scoring", beginWorkPoll("scoring"), false, new Date(start));

    const wakes = new Set<number>();
    for (let minute = 1; minute <= 24 * 60; minute += 1) {
      const tick = new Date(start + minute * 60_000);
      if (shouldCheckReminders(tick)) {
        wakes.add(minute);
        setEarliestReminder(null, tick);
      }
      if (minute % 15 === 0 && shouldPollWork("parse", tick)) {
        wakes.add(minute);
        completeWorkPoll("parse", beginWorkPoll("parse"), false, tick);
      }
      if (minute % 30 === 0 && shouldPollWork("scoring", tick)) {
        wakes.add(minute);
        completeWorkPoll("scoring", beginWorkPoll("scoring"), false, tick);
      }
    }

    // 06:00, 12:00, 18:00 и 00:00 следующих суток — и ничего между ними.
    expect([...wakes].sort((a, b) => a - b)).toEqual([360, 720, 1080, 1440]);
  });
});
