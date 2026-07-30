import { describe, expect, it } from "vitest";
import { normalizeText, phraseOccurs, stem, stemAll, tokenize } from "./text";

/**
 * Основа подбора категорий. Ошибка здесь не роняет ничего — она молча
 * раскладывает расходы не туда, и обнаруживается через месяц по кривой
 * разбивке в отчёте. Поэтому падежи проверяются явно, на тех самых словах,
 * которые лежат в справочнике.
 */

describe("нормализация", () => {
  it("не различает регистр, ё и пунктуацию", () => {
    expect(normalizeText("Заправка, 3 500₽!")).toBe("заправка 3 500");
    expect(normalizeText("Съёмка")).toBe(normalizeText("съемка"));
  });

  it("цифры сохраняет — они отличают «300к» от «300»", () => {
    expect(tokenize("оплатил 300к")).toEqual(["оплатил", "300к"]);
  });
});

describe("основа слова", () => {
  it("сводит падежи к одной основе", () => {
    expect(stem("рекламу")).toBe(stem("реклама"));
    expect(stem("бензина")).toBe(stem("бензин"));
    expect(stem("подписки")).toBe(stem("подписка"));
    expect(stem("серверов")).toBe(stem("сервер"));
    expect(stem("налоги")).toBe(stem("налог"));
  });

  it("короткие слова не трогает", () => {
    expect(stem("зп")).toBe("зп");
    expect(stem("жкх")).toBe("жкх");
  });

  it("латиницу не портит", () => {
    expect(stem("api")).toBe("api");
    expect(stem("github")).toBe("github");
  });

  it("не склеивает разные слова", () => {
    // «домен» не должен превращаться в «дом»: это разные категории расходов.
    expect(stem("домен")).not.toBe(stem("дом"));
    expect(stem("зал")).not.toBe(stem("залив"));
  });
});

describe("поиск фразы", () => {
  const text = (s: string) => stemAll(s);

  it("находит слово в любом падеже", () => {
    expect(phraseOccurs("реклама", text("потратил 12к на рекламу"))).toBe(true);
    expect(phraseOccurs("бензин", text("заправился, бензина на 3500"))).toBe(true);
  });

  it("находит фразу из двух слов", () => {
    expect(phraseOccurs("яндекс директ", text("оплатил яндекс директ 15000"))).toBe(true);
  });

  it("фраза должна идти подряд", () => {
    // Иначе «яндекс такси и директ» засчиталось бы как «яндекс директ» —
    // это два разных расхода, склеивать их хуже, чем не угадать.
    expect(phraseOccurs("яндекс директ", text("яндекс такси и директ"))).toBe(false);
  });

  it("чужого не находит", () => {
    expect(phraseOccurs("реклама", text("купил продукты"))).toBe(false);
  });

  it("пустой текст ничего не даёт", () => {
    expect(phraseOccurs("реклама", text(""))).toBe(false);
    expect(phraseOccurs("", text("реклама"))).toBe(false);
  });
});
