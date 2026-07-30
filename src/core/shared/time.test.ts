import { describe, it, expect } from "vitest";
import {
  OWNER_TZ,
  dayBounds,
  dayKey,
  formatLocal,
  localTimeParts,
  monthBounds,
  periodKey,
  weekBounds,
  yearBounds,
} from "./time";

/**
 * Тесты функций времени.
 *
 * Пояс передаётся ЯВНО почти везде. Это не педантизм: пояс владельца — это
 * настройка, он меняется при переезде, и тесты, молча опирающиеся на него,
 * массово краснеют при каждой смене. Тогда их правят «чтобы прошли», и ровно
 * в этот момент в них попадает неверное ожидание.
 *
 * Отдельный блок в конце проверяет то, что действительно зависит от настройки:
 * что пояс владельца именно тот, под который выставлено расписание кронов.
 */

/** Фиксированный пояс для проверки самой логики. UTC+3 круглый год. */
const TZ = "Europe/Moscow";

describe("periodKey", () => {
  it("режет месяцы по местному времени, а не по UTC", () => {
    // 31.07 в 22:00 UTC — это уже 1 августа в поясе UTC+3
    const lateJulyUtc = new Date("2026-07-31T22:00:00Z");
    expect(periodKey(lateJulyUtc, TZ)).toBe("2026-08");
  });

  it("операция в 02:00 по местному 1 августа не уезжает в июль", () => {
    const augustNight = new Date("2026-07-31T23:00:00Z");
    expect(periodKey(augustNight, TZ)).toBe("2026-08");
  });

  it("обычная середина месяца", () => {
    expect(periodKey(new Date("2026-07-15T12:00:00Z"), TZ)).toBe("2026-07");
  });
});

describe("dayKey", () => {
  it("даёт локальную дату", () => {
    expect(dayKey(new Date("2026-07-29T12:00:00Z"), TZ)).toBe("2026-07-29");
  });

  it("после локальной полуночи день уже следующий", () => {
    expect(dayKey(new Date("2026-07-29T21:30:00Z"), TZ)).toBe("2026-07-30");
  });
});

describe("dayBounds", () => {
  it("границы суток в UTC отстоят на 24 часа", () => {
    const { start, end } = dayBounds(new Date("2026-07-29T12:00:00Z"), TZ);
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("сутки UTC+3 начинаются в 21:00 UTC предыдущего дня", () => {
    const { start } = dayBounds(new Date("2026-07-29T12:00:00Z"), TZ);
    expect(start.toISOString()).toBe("2026-07-28T21:00:00.000Z");
  });

  it("сама дата попадает внутрь границ", () => {
    const d = new Date("2026-07-29T05:00:00Z");
    const { start, end } = dayBounds(d, TZ);
    expect(d.getTime()).toBeGreaterThanOrEqual(start.getTime());
    expect(d.getTime()).toBeLessThan(end.getTime());
  });
});

describe("monthBounds", () => {
  it("покрывает весь месяц", () => {
    const { start, end } = monthBounds(new Date("2026-07-15T12:00:00Z"), TZ);
    expect(start.toISOString()).toBe("2026-06-30T21:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-31T21:00:00.000Z");
  });

  it("правильно переваливает через границу года", () => {
    const { end } = monthBounds(new Date("2026-12-15T12:00:00Z"), TZ);
    expect(end.toISOString()).toBe("2026-12-31T21:00:00.000Z");
  });
});

describe("localTimeParts", () => {
  it("переводит UTC в местное время", () => {
    expect(localTimeParts(new Date("2026-07-29T04:30:00Z"), TZ)).toEqual({ hour: 7, minute: 30 });
  });
});

describe("formatLocal", () => {
  it("форматирует по-русски с ведущими нулями", () => {
    expect(formatLocal(new Date("2026-07-05T04:05:00Z"), TZ)).toBe("05.07.2026 07:05");
  });
});

describe("weekBounds", () => {
  it("начинает неделю с понедельника", () => {
    // Среда 22.07.2026 принадлежит неделе, начавшейся 20-го.
    const { start, end } = weekBounds(new Date("2026-07-22T12:00:00Z"), TZ);
    expect(start.toISOString()).toBe("2026-07-19T21:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-26T21:00:00.000Z");
  });

  it("воскресенье относит к уходящей неделе, а не к следующей", () => {
    // getDay() считает от воскресенья — без сдвига воскресный отчёт уехал бы
    // в следующую неделю и обнулил бы её итоги.
    const sunday = weekBounds(new Date("2026-07-26T12:00:00Z"), TZ);
    const wednesday = weekBounds(new Date("2026-07-22T12:00:00Z"), TZ);
    expect(sunday.start.toISOString()).toBe(wednesday.start.toISOString());
  });

  it("переваливает через границу месяца", () => {
    const { start } = weekBounds(new Date("2026-08-02T12:00:00Z"), TZ); // воскресенье
    expect(start.toISOString()).toBe("2026-07-26T21:00:00.000Z");
  });
});

describe("yearBounds", () => {
  it("режет год по локальной полуночи 1 января", () => {
    const { start, end } = yearBounds(new Date("2026-07-15T12:00:00Z"), TZ);
    expect(start.toISOString()).toBe("2025-12-31T21:00:00.000Z");
    expect(end.toISOString()).toBe("2026-12-31T21:00:00.000Z");
  });

  it("31 декабря 22:00 UTC — это уже следующий год в UTC+3", () => {
    const { start } = yearBounds(new Date("2026-12-31T22:00:00Z"), TZ);
    expect(start.toISOString()).toBe("2026-12-31T21:00:00.000Z");
  });
});

/**
 * А это зависит от настройки — и потому проверяется отдельно.
 *
 * По этим суткам режутся отчёты, и под них же выставлено расписание кронов в
 * scripts/start-container.mjs. Разъедутся — бриф придёт не утром, а месячный
 * итог перестанет сходиться с выпиской.
 */
describe("пояс владельца", () => {
  it("Екатеринбург, UTC+5", () => {
    expect(OWNER_TZ).toBe("Asia/Yekaterinburg");
    expect(localTimeParts(new Date("2026-07-29T04:30:00Z"))).toEqual({ hour: 9, minute: 30 });
  });

  it("сутки владельца начинаются в 19:00 UTC предыдущего дня", () => {
    const { start, end } = dayBounds(new Date("2026-07-29T12:00:00Z"));
    expect(start.toISOString()).toBe("2026-07-28T19:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-29T19:00:00.000Z");
  });

  it("месяц владельца режется по его полуночи", () => {
    const { start, end } = monthBounds(new Date("2026-07-15T12:00:00Z"));
    expect(start.toISOString()).toBe("2026-06-30T19:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-31T19:00:00.000Z");
  });

  it("операция в 02:00 местного 1 августа остаётся августовской", () => {
    // 01.08 02:00 в UTC+5 = 31.07 21:00 UTC. По UTC это ещё июль.
    expect(periodKey(new Date("2026-07-31T21:00:00Z"))).toBe("2026-08");
  });

  it("перевода часов нет: зимой и летом одинаково", () => {
    expect(localTimeParts(new Date("2026-01-15T12:00:00Z")).hour).toBe(17);
    expect(localTimeParts(new Date("2026-07-15T12:00:00Z")).hour).toBe(17);
  });
});
