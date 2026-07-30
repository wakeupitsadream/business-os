import { describe, it, expect } from "vitest";
import {
  dayBounds,
  dayKey,
  formatLocal,
  localTimeParts,
  monthBounds,
  periodKey,
  weekBounds,
  yearBounds,
} from "./time";

describe("periodKey", () => {
  it("режет месяцы по московскому времени, а не по UTC", () => {
    // 31.07 в 22:00 UTC — это уже 1 августа в Москве
    const lateJulyUtc = new Date("2026-07-31T22:00:00Z");
    expect(periodKey(lateJulyUtc)).toBe("2026-08");
  });

  it("операция в 02:00 МСК 1 августа не уезжает в июль", () => {
    // 01.08 02:00 МСК = 31.07 23:00 UTC
    const augustMoscowNight = new Date("2026-07-31T23:00:00Z");
    expect(periodKey(augustMoscowNight)).toBe("2026-08");
  });

  it("обычная середина месяца", () => {
    expect(periodKey(new Date("2026-07-15T12:00:00Z"))).toBe("2026-07");
  });
});

describe("dayKey", () => {
  it("даёт локальную дату владельца", () => {
    expect(dayKey(new Date("2026-07-29T12:00:00Z"))).toBe("2026-07-29");
  });

  it("после 21:00 UTC день уже следующий", () => {
    expect(dayKey(new Date("2026-07-29T21:30:00Z"))).toBe("2026-07-30");
  });
});

describe("dayBounds", () => {
  it("границы московских суток в UTC отстоят на 24 часа", () => {
    const { start, end } = dayBounds(new Date("2026-07-29T12:00:00Z"));
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("московские сутки начинаются в 21:00 UTC предыдущего дня", () => {
    const { start } = dayBounds(new Date("2026-07-29T12:00:00Z"));
    expect(start.toISOString()).toBe("2026-07-28T21:00:00.000Z");
  });

  it("сама дата попадает внутрь границ", () => {
    const d = new Date("2026-07-29T05:00:00Z");
    const { start, end } = dayBounds(d);
    expect(d.getTime()).toBeGreaterThanOrEqual(start.getTime());
    expect(d.getTime()).toBeLessThan(end.getTime());
  });
});

describe("monthBounds", () => {
  it("покрывает весь месяц", () => {
    const { start, end } = monthBounds(new Date("2026-07-15T12:00:00Z"));
    expect(start.toISOString()).toBe("2026-06-30T21:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-31T21:00:00.000Z");
  });

  it("правильно переваливает через границу года", () => {
    const { end } = monthBounds(new Date("2026-12-15T12:00:00Z"));
    expect(end.toISOString()).toBe("2026-12-31T21:00:00.000Z");
  });
});

describe("localTimeParts", () => {
  it("переводит UTC в московское время", () => {
    expect(localTimeParts(new Date("2026-07-29T04:30:00Z"))).toEqual({ hour: 7, minute: 30 });
  });
});

describe("formatLocal", () => {
  it("форматирует по-русски с ведущими нулями", () => {
    expect(formatLocal(new Date("2026-07-05T04:05:00Z"))).toBe("05.07.2026 07:05");
  });
});

describe("weekBounds", () => {
  it("начинает неделю с понедельника", () => {
    // Среда 22.07.2026 принадлежит неделе, начавшейся 20-го.
    const { start, end } = weekBounds(new Date("2026-07-22T12:00:00Z"));
    expect(start.toISOString()).toBe("2026-07-19T21:00:00.000Z"); // 20.07 00:00 МСК
    expect(end.toISOString()).toBe("2026-07-26T21:00:00.000Z");
  });

  it("воскресенье относит к уходящей неделе, а не к следующей", () => {
    // getDay() считает от воскресенья — без сдвига воскресный отчёт уехал бы
    // в следующую неделю и обнулил бы её итоги.
    const sunday = weekBounds(new Date("2026-07-26T12:00:00Z"));
    const wednesday = weekBounds(new Date("2026-07-22T12:00:00Z"));
    expect(sunday.start.toISOString()).toBe(wednesday.start.toISOString());
  });

  it("переваливает через границу месяца", () => {
    const { start } = weekBounds(new Date("2026-08-02T12:00:00Z")); // воскресенье
    expect(start.toISOString()).toBe("2026-07-26T21:00:00.000Z"); // 27.07 МСК
  });
});

describe("yearBounds", () => {
  it("режет год по московской полуночи 1 января", () => {
    const { start, end } = yearBounds(new Date("2026-07-15T12:00:00Z"));
    expect(start.toISOString()).toBe("2025-12-31T21:00:00.000Z");
    expect(end.toISOString()).toBe("2026-12-31T21:00:00.000Z");
  });

  it("31 декабря 22:00 UTC — это уже следующий год владельца", () => {
    const { start } = yearBounds(new Date("2026-12-31T22:00:00Z"));
    expect(start.toISOString()).toBe("2026-12-31T21:00:00.000Z");
  });
});
