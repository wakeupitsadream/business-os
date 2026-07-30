import { describe, expect, it } from "vitest";
import { parseStatementAmount, parseStatementDate } from "./values";
import { parseAmountToKop } from "@/core/shared/money";
import { dayKey } from "@/core/shared/time";

/**
 * Разбор значений из ячеек выписки.
 *
 * Самая дорогая ошибка в импорте живёт здесь: потерянный знак превращает
 * расход в доход, а неверный разряд — 12 000 ₽ в 12 000 000 ₽. И то и другое
 * выглядит как нормальное число, поэтому проверяется явно.
 */

describe("суммы", () => {
  it("минус означает расход, сумма при этом положительная", () => {
    expect(parseStatementAmount("-3 500,00")).toEqual({ amountKop: 350_000, negative: true });
  });

  it("без знака — доход", () => {
    expect(parseStatementAmount("40 000,00")).toEqual({ amountKop: 4_000_000, negative: false });
    expect(parseStatementAmount("+1000")).toEqual({ amountKop: 100_000, negative: false });
  });

  it("понимает и запятую, и точку как дробный разделитель", () => {
    expect(parseStatementAmount("1234.56")?.amountKop).toBe(123_456);
    expect(parseStatementAmount("1234,56")?.amountKop).toBe(123_456);
  });

  it("разделитель разрядов не путается с дробным", () => {
    // «1.234» — это тысяча двести тридцать четыре, а не рубль с копейками.
    expect(parseStatementAmount("1.234")?.amountKop).toBe(123_400);
    expect(parseStatementAmount("1 234,50")?.amountKop).toBe(123_450);
  });

  it("неразрывный пробел и символ валюты в ячейке не мешают", () => {
    expect(parseStatementAmount("-1 500,00 ₽")?.amountKop).toBe(150_000);
  });

  it("типографский минус читается как минус", () => {
    // Из PDF и веб-таблиц приезжает U+2212, а не ASCII-дефис.
    expect(parseStatementAmount("−777,00")?.negative).toBe(true);
  });

  it("НЕ понимает разговорные суффиксы — это ячейка банка, а не речь владельца", () => {
    // parseAmountToKop написан для «3тр» и «12к» из диалога. Применить его к
    // выписке значит однажды умножить сумму на тысячу и не заметить этого.
    expect(parseAmountToKop("12к")).toBe(1_200_000);
    expect(parseStatementAmount("12к")?.amountKop).toBe(1_200);
  });

  it("ноль операцией не считается", () => {
    expect(parseStatementAmount("0,00")).toBeNull();
  });

  it("мусор не превращается в сумму", () => {
    expect(parseStatementAmount("не число")).toBeNull();
    expect(parseStatementAmount("")).toBeNull();
    expect(parseStatementAmount("—")).toBeNull();
  });

  it("сумма за пределами Int32 отвергается, а не переполняется молча", () => {
    // Переполнение всплыло бы месяцем позже как необъяснимо отрицательный оборот.
    expect(parseStatementAmount("99 999 999 999,00")).toBeNull();
  });
});

describe("даты", () => {
  it("дата с временем читается как московская", () => {
    // 14:23 МСК — это 11:23 UTC. Прочитать как UTC значит сдвинуть операцию.
    const d = parseStatementDate("05.07.2026 14:23:05");
    expect(d?.toISOString()).toBe("2026-07-05T11:23:05.000Z");
  });

  it("дата без времени — московская полночь", () => {
    const d = parseStatementDate("05.07.2026");
    expect(d?.toISOString()).toBe("2026-07-04T21:00:00.000Z");
    expect(d && dayKey(d)).toBe("2026-07-05");
  });

  it("операция первого числа ночью остаётся в своём месяце", () => {
    // Ровно тот случай, из-за которого месячный итог расходится с выпиской.
    const d = parseStatementDate("01.08.2026 01:00:00");
    expect(d?.toISOString()).toBe("2026-07-31T22:00:00.000Z");
    expect(d && dayKey(d)).toBe("2026-08-01");
  });

  it("понимает ISO как запасной формат", () => {
    expect(parseStatementDate("2026-07-05")?.toISOString()).toBe("2026-07-04T21:00:00.000Z");
  });

  it("несуществующая дата отвергается, а не переезжает на март", () => {
    // 31 февраля большинство библиотек молча превращает в 3 марта — и операция
    // оказывается не в том месяце.
    expect(parseStatementDate("31.02.2026")).toBeNull();
    expect(parseStatementDate("05.13.2026")).toBeNull();
  });

  it("мусор датой не становится", () => {
    expect(parseStatementDate("вчера")).toBeNull();
    expect(parseStatementDate("")).toBeNull();
  });
});
