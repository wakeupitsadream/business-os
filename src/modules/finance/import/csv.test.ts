import { describe, expect, it } from "vitest";
import { detectDelimiter, normalizeHeader, parseCsv } from "./csv";
import { decodeStatement } from "./decode";

/**
 * Разбор файла — фундамент импорта. Ошибка здесь не падает, а тихо сдвигает
 * колонки: сумма уезжает в описание, дата в категорию, и владелец получает
 * импорт, который выглядит правдоподобно и не сходится с банком.
 */

describe("разделитель", () => {
  it("узнаёт точку с запятой — формат российских банков", () => {
    expect(detectDelimiter('"Дата";"Сумма";"Описание"')).toBe(";");
  });

  it("узнаёт запятую", () => {
    expect(detectDelimiter("date,amount,description")).toBe(",");
  });

  it("запятая внутри заголовка не побеждает настоящий разделитель", () => {
    // «Сумма, ₽» — обычный заголовок, и запятая в нём не разделитель.
    expect(detectDelimiter('"Дата";"Сумма, ₽";"Описание"')).toBe(";");
  });

  it("смотрит только на первую строку", () => {
    expect(detectDelimiter('"Дата";"Описание"\n"01.07.2026";"кафе, обед, чай"')).toBe(";");
  });
});

describe("разбор строк", () => {
  it("читает простую таблицу", () => {
    expect(parseCsv("a;b;c\n1;2;3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("снимает кавычки", () => {
    expect(parseCsv('"Дата";"Сумма"\n"01.07.2026";"-3 500,00"')).toEqual([
      ["Дата", "Сумма"],
      ["01.07.2026", "-3 500,00"],
    ]);
  });

  it("разделитель внутри кавычек остаётся текстом", () => {
    // Ровно то, на чём ломается line.split(";").
    const [, row] = parseCsv('"Описание"\n"АЗС Лукойл; трасса М5"');
    expect(row).toEqual(["АЗС Лукойл; трасса М5"]);
  });

  it("перевод строки внутри кавычек не начинает новую строку", () => {
    const rows = parseCsv('"Описание";"Сумма"\n"Перевод\nот клиента";"1000"');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(["Перевод\nот клиента", "1000"]);
  });

  it("удвоенная кавычка — это одна кавычка в данных", () => {
    const [, row] = parseCsv('"Описание"\n"ООО ""Ромашка"""');
    expect(row).toEqual(['ООО "Ромашка"']);
  });

  it("понимает CRLF", () => {
    expect(parseCsv("a;b\r\n1;2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("пустые поля сохраняются на своих местах", () => {
    // Схлопнуть их значит сдвинуть все последующие колонки.
    expect(parseCsv("a;b;c\n1;;3")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });

  it("хвостовой перевод строки не даёт лишней строки", () => {
    expect(parseCsv("a;b\n1;2\n")).toHaveLength(2);
  });

  it("одна колонка тоже таблица", () => {
    expect(parseCsv("Описание\nкофе\nобед")).toEqual([["Описание"], ["кофе"], ["обед"]]);
  });

  it("пустой файл даёт пустой результат", () => {
    expect(parseCsv("")).toEqual([]);
  });
});

describe("нормализация заголовка", () => {
  it("не различает регистр, ё и пунктуацию", () => {
    expect(normalizeHeader("Сумма платежа, ₽")).toBe("сумма платежа");
    expect(normalizeHeader("Кэшбэк")).toBe(normalizeHeader("КЭШБЭК"));
  });
});

describe("кодировка", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("cp1251 читается как русский текст, а не как кракозябры", () => {
    // «АЗС Лукойл» в cp1251.
    const bytes = new Uint8Array([
      0xc0, 0xc7, 0xd1, 0x20, 0xcb, 0xf3, 0xea, 0xee, 0xe9, 0xeb,
    ]);
    const decoded = decodeStatement(bytes);
    expect(decoded.encoding).toBe("windows-1251");
    expect(decoded.text).toBe("АЗС Лукойл");
  });

  it("UTF-8 с BOM распознаётся точно и BOM не попадает в текст", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc("Дата;Сумма")]);
    const decoded = decodeStatement(bytes);
    expect(decoded.encoding).toBe("utf-8");
    expect(decoded.certain).toBe(true);
    expect(decoded.text).toBe("Дата;Сумма");
  });

  it("UTF-8 без BOM не принимается за cp1251", () => {
    const decoded = decodeStatement(enc("Перевод от клиента"));
    expect(decoded.encoding).toBe("utf-8");
    expect(decoded.text).toBe("Перевод от клиента");
  });

  it("латиница читается одинаково в любой кодировке", () => {
    expect(decodeStatement(enc("date;amount")).text).toBe("date;amount");
  });
});
