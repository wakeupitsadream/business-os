import { describe, expect, it } from "vitest";
import { explicitRange, resolvePeriod } from "./period";

/**
 * Границы периодов. Именно здесь проходит разница между «сошлось с выпиской»
 * и «не сошлось»: операция 1 июля в 02:00 местного по UTC ещё июньская, и месячный
 * итог, посчитанный по UTC, отличается от банковского.
 *
 * Екатеринбург — UTC+5 круглый год, перевода часов нет. Поэтому начало месяца
 * по владельцу — это 19:00 предыдущего дня по UTC.
 */

const iso = (d: Date) => d.toISOString();

describe("месяц по времени владельца", () => {
  it("режется по полуночи владельца, а не по UTC", () => {
    const r = resolvePeriod("month", new Date("2026-07-15T12:00:00Z"));
    expect(iso(r.start)).toBe("2026-06-30T19:00:00.000Z");
    expect(iso(r.end)).toBe("2026-07-31T19:00:00.000Z");
  });

  it("операция 1 июля в 02:00 местного попадает в июль", () => {
    const r = resolvePeriod("month", new Date("2026-07-15T12:00:00Z"));
    const tx = new Date("2026-06-30T23:00:00Z"); // 02:00 местного 1 июля
    expect(tx >= r.start && tx < r.end).toBe(true);
  });

  it("ярлык называет месяц владельца, а не UTC", () => {
    expect(resolvePeriod("month", new Date("2026-07-15T12:00:00Z")).label).toBe("июль 2026");
  });
});

describe("прошлый месяц", () => {
  it("в январе уходит в декабрь прошлого года", () => {
    // Наивное «месяц − 1» здесь даёт месяц −1 и ломает год.
    const r = resolvePeriod("prev_month", new Date("2026-01-15T12:00:00Z"));
    expect(r.label).toBe("декабрь 2025");
    expect(iso(r.start)).toBe("2025-11-30T19:00:00.000Z");
    expect(iso(r.end)).toBe("2025-12-31T19:00:00.000Z");
  });

  it("границы прошлого месяца стыкуются с текущим без зазора", () => {
    const now = new Date("2026-07-15T12:00:00Z");
    expect(iso(resolvePeriod("prev_month", now).end)).toBe(iso(resolvePeriod("month", now).start));
  });
});

describe("неделя", () => {
  it("начинается с понедельника", () => {
    // Воскресенье 2026-07-26 по московскому времени принадлежит неделе,
    // начавшейся в понедельник 20-го.
    const r = resolvePeriod("week", new Date("2026-07-26T12:00:00Z"));
    expect(iso(r.start)).toBe("2026-07-19T19:00:00.000Z"); // 20 июля 00:00 местного
    expect(iso(r.end)).toBe("2026-07-26T19:00:00.000Z");
  });

  it("прошлая неделя стыкуется с текущей", () => {
    const now = new Date("2026-07-26T12:00:00Z");
    expect(iso(resolvePeriod("prev_week", now).end)).toBe(iso(resolvePeriod("week", now).start));
  });
});

describe("сутки", () => {
  it("вчера кончается там, где начинается сегодня", () => {
    const now = new Date("2026-07-15T12:00:00Z");
    expect(iso(resolvePeriod("yesterday", now).end)).toBe(iso(resolvePeriod("today", now).start));
  });

  it("после полуночи владельца «сегодня» — уже новый день", () => {
    // 00:30 местного 16 июля.
    const r = resolvePeriod("today", new Date("2026-07-15T21:30:00Z"));
    expect(iso(r.start)).toBe("2026-07-15T19:00:00.000Z");
  });
});

describe("год и квартал", () => {
  it("год режется по полуночи владельца 1 января", () => {
    const r = resolvePeriod("year", new Date("2026-07-15T12:00:00Z"));
    expect(iso(r.start)).toBe("2025-12-31T19:00:00.000Z");
    expect(r.label).toBe("2026 год");
  });

  it("квартал — три месяца, включая текущий", () => {
    const r = resolvePeriod("quarter", new Date("2026-07-15T12:00:00Z"));
    expect(iso(r.start)).toBe("2026-04-30T19:00:00.000Z"); // 1 мая по владельцу
    expect(iso(r.end)).toBe("2026-07-31T19:00:00.000Z");
  });
});

describe("произвольный диапазон", () => {
  it("конечная дата включается целиком", () => {
    // Модель присылает «по 31 июля», подразумевая включительно. Без этого
    // последний день месяца молча выпадал бы из отчёта.
    const r = explicitRange("2026-07-01", "2026-07-31");
    expect(r).not.toBeNull();
    expect(iso(r!.end)).toBe("2026-07-31T19:00:00.000Z");
  });

  it("мусор и перевёрнутый диапазон отвергаются", () => {
    expect(explicitRange("вчера", "сегодня")).toBeNull();
    expect(explicitRange("2026-07-31", "2026-07-01")).toBeNull();
  });
});

describe("всё время", () => {
  it("включает сегодняшнюю операцию", () => {
    const now = new Date("2026-07-15T12:00:00Z");
    const r = resolvePeriod("all", now);
    expect(now >= r.start && now < r.end).toBe(true);
  });
});
