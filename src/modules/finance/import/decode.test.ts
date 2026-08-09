import { describe, expect, it } from "vitest";
import { binaryFormatHint, decodeStatement, detectBinaryFormat } from "./decode";

/**
 * Определение кодировки и формата присланного файла.
 */

describe("кодировка", () => {
  it("cp1251 не выдаётся за UTF-8", () => {
    // «АЗС» в windows-1251. Как UTF-8 эти байты не разбираются — на этом и
    // построено различение, иначе кириллица превратилась бы в кракозябры.
    const cp1251 = new Uint8Array([0xc0, 0xc7, 0xd1]);
    const decoded = decodeStatement(cp1251);
    expect(decoded.encoding).toBe("windows-1251");
    expect(decoded.text).toBe("АЗС");
  });

  it("UTF-8 остаётся UTF-8", () => {
    const utf8 = new TextEncoder().encode("АЗС Лукойл");
    expect(decodeStatement(utf8).encoding).toBe("utf-8");
  });
});

describe("не-текстовые форматы", () => {
  /**
   * Владелец присылает то, что даёт банк, а Т-Банк по кнопке «Справка о
   * движении средств» даёт PDF. Без этой проверки такой файл разбирался бы в
   * мусор и упирался в «не тот формат» — сообщение, из которого непонятно, что
   * делать: файл-то правильный, просто не в том виде.
   */
  const bytesOf = (head: number[]) => new Uint8Array([...head, ...Array(64).fill(0x20)]);

  it("PDF узнаётся по сигнатуре, а не по расширению", () => {
    expect(detectBinaryFormat(bytesOf([0x25, 0x50, 0x44, 0x46]))).toBe("pdf");
  });

  it("xlsx и любой zip узнаются", () => {
    expect(detectBinaryFormat(bytesOf([0x50, 0x4b, 0x03, 0x04]))).toBe("zip");
  });

  it("старый .xls узнаётся", () => {
    expect(detectBinaryFormat(bytesOf([0xd0, 0xcf, 0x11, 0xe0]))).toBe("excel");
  });

  it("настоящий CSV не принимается за бинарный", () => {
    const csv = new TextEncoder().encode('"Дата операции";"Сумма операции"\n');
    expect(detectBinaryFormat(csv)).toBeNull();
  });

  it("подсказка говорит, где взять CSV, а не только что файл не тот", () => {
    const hint = binaryFormatHint("pdf");
    expect(hint).toContain("CSV");
    expect(hint).toMatch(/выписк/i);
  });
});
