import { describe, expect, it } from "vitest";
import { addStats, EMPTY_STATS, readStats } from "./jobs";
import { firstNormalizedPhone } from "./runner";

/**
 * Счётчики прогона и разбор телефонов.
 *
 * Проверяется одно свойство, но важное: ни то, ни другое не имеет права
 * уронить крон. Прогон лидогена живёт днями, формат счётчиков между деплоями
 * может смениться, а источник кладёт в телефоны что угодно.
 */

describe("счётчики прогона", () => {
  it("складываются по частям", () => {
    const after = addStats(addStats(EMPTY_STATS, { pages: 1, found: 50, stored: 50 }), {
      pages: 1,
      found: 50,
      stored: 20,
      duplicates: 30,
    });
    expect(after).toEqual({ pages: 2, requestsUsed: 0, found: 100, stored: 70, duplicates: 30 });
  });

  it("читаются терпимо: чужая форма даёт нули, а не исключение", () => {
    // Уронить крон из-за поля в счётчике — цена, несопоставимая с пользой.
    expect(readStats(null)).toEqual(EMPTY_STATS);
    expect(readStats({ pages: "две" })).toEqual(EMPTY_STATS);
    expect(readStats({ pages: 1 })).toEqual(EMPTY_STATS);
    expect(readStats({ ...EMPTY_STATS, pages: 3 })).toMatchObject({ pages: 3 });
  });

  it("прочитанные счётчики не ссылаются на общий объект", () => {
    // Иначе первый же addStats на месте испортил бы EMPTY_STATS для всех.
    const a = readStats(null);
    a.pages = 99;
    expect(readStats(null).pages).toBe(0);
    expect(EMPTY_STATS.pages).toBe(0);
  });
});

describe("телефон кандидата", () => {
  it("берётся первый, который вообще похож на номер", () => {
    expect(firstNormalizedPhone(["доб. 102", "8 (999) 123-45-67"])).toBe("79991234567");
  });

  it("мусорный ключ дедупа хуже отсутствующего", () => {
    // «+7» и «8» — не номера. Попав в ключ, они склеили бы разные компании.
    expect(firstNormalizedPhone(["+7", "8", "доб. 102"])).toBeNull();
    expect(firstNormalizedPhone([])).toBeNull();
  });
});
