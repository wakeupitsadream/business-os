import { describe, expect, it } from "vitest";
import { parseCards } from "./phrasing";
import type { Fact } from "./facts";

/**
 * Разбор карточек, сформулированных моделью.
 *
 * Единственное, что здесь по-настоящему важно: карточка обязана опираться на
 * переданный факт. Модель, которой дали шесть фактов и попросили сделать
 * выводы, охотно добавляет седьмой — правдоподобный и выдуманный. Именно он и
 * попадёт на экран как наблюдение о деньгах владельца.
 */

const FACTS: Fact[] = [
  {
    id: "trend:ads",
    kind: "trend",
    text: "Расход по категории «Реклама» вырос на 200%.",
    data: { percent: 200 },
    weight: 1,
  },
  {
    id: "profit:month",
    kind: "profit",
    text: "За месяц прибыль 50000 ₽.",
    data: { profitKop: 5_000_000 },
    weight: 1,
  },
];

const card = (over: Record<string, unknown> = {}) => ({
  title: "Реклама съедает больше",
  body: "Расходы на рекламу выросли втрое за месяц. Стоит сверить с числом заявок.",
  factIds: ["trend:ads"],
  severity: "warning",
  ...over,
});

const reply = (cards: unknown[]) => JSON.stringify({ cards });

describe("ссылки на факты", () => {
  it("карточка с валидной ссылкой проходит", () => {
    const cards = parseCards(reply([card()]), FACTS);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.factIds).toEqual(["trend:ads"]);
  });

  it("карточка со ссылкой на несуществующий факт отбрасывается", () => {
    // Это и есть защита от выдуманного наблюдения.
    expect(parseCards(reply([card({ factIds: ["trend:выдумка"] })]), FACTS)).toHaveLength(0);
  });

  it("карточка вообще без ссылок отбрасывается", () => {
    expect(parseCards(reply([card({ factIds: [] })]), FACTS)).toHaveLength(0);
    expect(parseCards(reply([card({ factIds: undefined })]), FACTS)).toHaveLength(0);
  });

  it("выдуманные ссылки отсеиваются, настоящие остаются", () => {
    const cards = parseCards(
      reply([card({ factIds: ["trend:ads", "выдумка", "profit:month"] })]),
      FACTS,
    );
    expect(cards[0]?.factIds).toEqual(["trend:ads", "profit:month"]);
  });

  it("хорошие карточки не страдают из-за плохой соседки", () => {
    const cards = parseCards(
      reply([card({ factIds: ["нет такого"] }), card({ title: "Прибыль растёт" })]),
      FACTS,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.title).toBe("Прибыль растёт");
  });
});

describe("разбор ответа", () => {
  it("понимает JSON в markdown-ограде", () => {
    const raw = "```json\n" + reply([card()]) + "\n```";
    expect(parseCards(raw, FACTS)).toHaveLength(1);
  });

  it("непонятный ответ не роняет джобу", () => {
    expect(parseCards("Извини, не могу помочь.", FACTS)).toEqual([]);
    expect(parseCards("", FACTS)).toEqual([]);
    expect(parseCards("{сломанный json", FACTS)).toEqual([]);
  });

  it("пустой заголовок или огрызок текста не проходят", () => {
    expect(parseCards(reply([card({ title: "" })]), FACTS)).toHaveLength(0);
    expect(parseCards(reply([card({ body: "ок" })]), FACTS)).toHaveLength(0);
  });

  it("количество карточек ограничено", () => {
    const many = Array.from({ length: 10 }, (_, i) => card({ title: `Карточка ${i}` }));
    expect(parseCards(reply(many), FACTS).length).toBeLessThanOrEqual(3);
  });

  it("мусорные элементы списка пропускаются", () => {
    const cards = parseCards(reply([null, card(), "строка", 42]), FACTS);
    expect(cards).toHaveLength(1);
  });

  it("неизвестная важность заменяется на нейтральную", () => {
    const cards = parseCards(reply([card({ severity: "КАТАСТРОФА" })]), FACTS);
    expect(cards[0]?.severity).toBe("info");
  });

  it("длинный текст обрезается, а не отбрасывается", () => {
    const cards = parseCards(reply([card({ body: "а".repeat(2000) })]), FACTS);
    expect(cards[0]?.body.length).toBeLessThanOrEqual(600);
  });
});
