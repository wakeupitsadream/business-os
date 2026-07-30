import { describe, expect, it } from "vitest";
import { categorizeImportedRow, parseCategoryRules, type CategoryRuleSet } from "./rules";

/**
 * Автокатегоризация импорта. Ошибка здесь не падает — она молча кладёт
 * заправку в «Питание», и владелец видит разбивку расходов, которая выглядит
 * правдоподобно и не соответствует действительности.
 */

const set = (
  id: string,
  name: string,
  rules: Array<{ contains?: string; mcc?: number }>,
  aliases: string[] = [],
  parentId: string | null = null,
): CategoryRuleSet => ({ id, name, type: "EXPENSE", aliases, parentId, rules });

const SETS: CategoryRuleSet[] = [
  set("cat_transport", "Транспорт", [{ mcc: 5541 }, { contains: "АЗС" }], ["бензин"], "cat_ops"),
  set("cat_food", "Питание", [{ mcc: 5411 }, { contains: "ПЯТЕРОЧКА" }], ["еда"], "cat_ops"),
  set("cat_marketing", "Маркетинг", [{ contains: "ЯНДЕКС" }], ["маркетинг"]),
  set("cat_ads", "Реклама", [{ contains: "ЯНДЕКС ДИРЕКТ" }], ["реклама"], "cat_marketing"),
];

describe("подбор по MCC", () => {
  it("код платёжной системы решает вопрос", () => {
    const hit = categorizeImportedRow({ description: "AZS 0345", mcc: 5541 }, SETS);
    expect(hit?.id).toBe("cat_transport");
    expect(hit?.via).toBe("mcc");
  });

  it("MCC сильнее подстроки", () => {
    // Описание намекает на «Пятёрочку», но код говорит «заправка». Код
    // присвоила платёжная система, и он надёжнее любого названия.
    const hit = categorizeImportedRow({ description: "ПЯТЕРОЧКА на АЗС", mcc: 5541 }, SETS);
    expect(hit?.id).toBe("cat_transport");
  });

  it("незнакомый MCC не мешает подбору по тексту", () => {
    const hit = categorizeImportedRow({ description: "ПЯТЕРОЧКА 123", mcc: 9999 }, SETS);
    expect(hit?.id).toBe("cat_food");
    expect(hit?.via).toBe("contains");
  });
});

describe("подбор по подстроке", () => {
  it("не зависит от регистра", () => {
    expect(categorizeImportedRow({ description: "оплата азс лукойл" }, SETS)?.id).toBe(
      "cat_transport",
    );
  });

  it("длинная подстрока побеждает короткую", () => {
    // «яндекс директ» конкретнее «яндекс»: у Яндекса есть и такси, и реклама.
    const hit = categorizeImportedRow({ description: 'ООО "ЯНДЕКС" ДИРЕКТ оплата' }, SETS);
    expect(hit?.id).toBe("cat_ads");
  });

  it("категория, проставленная банком, тоже участвует", () => {
    const hit = categorizeImportedRow(
      { description: "Покупка 4321", bankCategory: "ПЯТЕРОЧКА" },
      SETS,
    );
    expect(hit?.id).toBe("cat_food");
  });
});

describe("алиасы как последняя ступень", () => {
  it("подхватывают то, что не поймали правила", () => {
    const hit = categorizeImportedRow({ description: "оплата за бензин подрядчику" }, SETS);
    expect(hit?.id).toBe("cat_transport");
    expect(hit?.via).toBe("alias");
  });
});

describe("когда не подошло ничего", () => {
  it("категория остаётся пустой, а не «Прочим»", () => {
    // Пустая категория видна в предпросмотре и вызывает вопрос. «Прочее»
    // выглядит как осмысленное решение и через полгода собирает треть оборота.
    expect(categorizeImportedRow({ description: "Перевод Иванову И.И." }, SETS)).toBeNull();
  });

  it("пустой справочник не роняет подбор", () => {
    expect(categorizeImportedRow({ description: "АЗС", mcc: 5541 }, [])).toBeNull();
  });
});

describe("разбор колонки rules", () => {
  it("читает правила", () => {
    expect(parseCategoryRules([{ mcc: 5541 }, { contains: "АЗС" }])).toEqual([
      { mcc: 5541 },
      { contains: "АЗС" },
    ]);
  });

  it("мусор в колонке не роняет импорт", () => {
    // Json-колонку может испортить правка руками или старый формат после
    // деплоя. Импорт из-за этого падать не должен.
    expect(parseCategoryRules(null)).toEqual([]);
    expect(parseCategoryRules("строка")).toEqual([]);
    expect(parseCategoryRules({})).toEqual([]);
    expect(parseCategoryRules([null, 42, "x"])).toEqual([]);
  });

  it("отбрасывает частично битые правила, сохраняя целые", () => {
    expect(parseCategoryRules([{ mcc: "abc" }, { contains: "АЗС" }, { contains: "  " }])).toEqual([
      { contains: "АЗС" },
    ]);
  });
});
