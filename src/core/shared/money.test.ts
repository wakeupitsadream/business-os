import { describe, it, expect } from "vitest";
import {
  MAX_KOP,
  MoneyRangeError,
  THOUSANDS_SEPARATOR as NB,
  assertKopInRange,
  formatKop,
  kopToRubles,
  parseAmountToKop,
  percentChange,
  rublesToKop,
} from "./money";

describe("rublesToKop", () => {
  it("переводит рубли в копейки", () => {
    expect(rublesToKop(1)).toBe(100);
    expect(rublesToKop(1234.56)).toBe(123456);
  });

  it("округляет копейки, а не отбрасывает", () => {
    expect(rublesToKop(0.005)).toBe(1);
    expect(rublesToKop(10.004)).toBe(1000);
  });

  it("не теряет точность на суммах, где ломается float", () => {
    // 0.1 + 0.2 !== 0.3 — ради этого случая и введены копейки
    expect(rublesToKop(0.1) + rublesToKop(0.2)).toBe(rublesToKop(0.3));
  });

  it("отклоняет суммы вне Int32", () => {
    expect(() => rublesToKop(30_000_000)).toThrow(MoneyRangeError);
  });
});

describe("assertKopInRange", () => {
  it("пропускает граничное значение", () => {
    expect(assertKopInRange(MAX_KOP)).toBe(MAX_KOP);
    expect(assertKopInRange(-MAX_KOP)).toBe(-MAX_KOP);
  });

  it("отклоняет переполнение, NaN и дробное", () => {
    expect(() => assertKopInRange(MAX_KOP + 1)).toThrow(MoneyRangeError);
    expect(() => assertKopInRange(Number.NaN)).toThrow(MoneyRangeError);
    expect(() => assertKopInRange(10.5)).toThrow(MoneyRangeError);
  });
});

describe("parseAmountToKop", () => {
  it("разбирает простые числа", () => {
    expect(parseAmountToKop("3500")).toBe(350_000);
    expect(parseAmountToKop("1 200,50")).toBe(120_050);
    expect(parseAmountToKop("1200.50")).toBe(120_050);
  });

  it("понимает разговорные суффиксы тысяч", () => {
    expect(parseAmountToKop("3тр")).toBe(300_000);
    expect(parseAmountToKop("15к")).toBe(1_500_000);
    expect(parseAmountToKop("2 тыс")).toBe(200_000);
    expect(parseAmountToKop("1.5к")).toBe(150_000);
  });

  it("понимает миллионы", () => {
    expect(parseAmountToKop("2млн")).toBe(200_000_000);
  });

  it("возвращает null, когда числа нет", () => {
    expect(parseAmountToKop("потратил на бензин")).toBeNull();
    expect(parseAmountToKop("")).toBeNull();
  });

  it("возвращает null вместо переполнения", () => {
    expect(parseAmountToKop("999999млн")).toBeNull();
  });
});

describe("formatKop", () => {
  it("группирует разряды и скрывает нулевые копейки", () => {
    expect(formatKop(12_854_000)).toBe(`128${NB}540${NB}₽`);
    expect(formatKop(0)).toBe(`0${NB}₽`);
  });

  it("показывает ненулевые копейки", () => {
    expect(formatKop(120_050)).toBe(`1${NB}200,50${NB}₽`);
  });

  it("показывает копейки принудительно", () => {
    expect(formatKop(100_000, { alwaysKopecks: true })).toBe(`1${NB}000,00${NB}₽`);
  });

  it("ставит минус перед отрицательной суммой", () => {
    expect(formatKop(-234_000)).toBe(`−2${NB}340${NB}₽`);
  });

  it("ставит плюс только по запросу и только для положительных", () => {
    expect(formatKop(234_000, { sign: true })).toBe(`+2${NB}340${NB}₽`);
    expect(formatKop(-234_000, { sign: true })).toBe(`−2${NB}340${NB}₽`);
  });

  it("разделитель — неразрывный пробел, чтобы число не рвалось по строкам", () => {
    expect(NB).toBe("\u00A0");
    expect(formatKop(12_854_000)).not.toContain(" ");
  });
});

describe("kopToRubles", () => {
  it("переводит обратно", () => {
    expect(kopToRubles(123_456)).toBe(1234.56);
  });
});

describe("percentChange", () => {
  it("считает рост и падение", () => {
    expect(percentChange(120, 100)).toBe(20);
    expect(percentChange(80, 100)).toBe(-20);
  });

  it("возвращает null при нулевой базе — делить не на что", () => {
    expect(percentChange(100, 0)).toBeNull();
  });

  it("корректно работает от отрицательной базы", () => {
    // расходы были −100, стали −150: изменение +50% по модулю базы
    expect(percentChange(-150, -100)).toBe(-50);
  });
});
