import { describe, expect, it } from "vitest";
import { TELEGRAM_TEXT_LIMIT, splitTextForMessenger } from "./split-text";

/** Сравнение без пробелов: нарезка вправе съесть разделитель, но не символы. */
const dense = (s: string) => s.replace(/\s+/g, "");

describe("splitTextForMessenger", () => {
  it("короткий текст возвращает одним куском", () => {
    expect(splitTextForMessenger("привет", 100)).toEqual(["привет"]);
  });

  it("пустой текст не порождает сообщений", () => {
    expect(splitTextForMessenger("", 100)).toEqual([]);
    expect(splitTextForMessenger("   ", 2)).toEqual([]);
  });

  it("текст ровно по лимиту не режется", () => {
    const text = "я".repeat(50);
    expect(splitTextForMessenger(text, 50)).toEqual([text]);
  });

  it("режет по границе абзаца", () => {
    const first = "Первый абзац. ".repeat(4).trim();
    const second = "Второй абзац. ".repeat(4).trim();
    const chunks = splitTextForMessenger(`${first}\n\n${second}`, first.length + 10);
    expect(chunks).toEqual([first, second]);
  });

  it("режет по строке, когда абзацев нет", () => {
    const line = "строка номер один";
    const text = `${line}\n${line}\n${line}`;
    const chunks = splitTextForMessenger(text, line.length * 2 + 1);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.endsWith(line)).toBe(true);
  });

  it("не рвёт слово посередине, если есть пробел", () => {
    const text = "алгоритмизация ".repeat(20).trim();
    const chunks = splitTextForMessenger(text, 100);
    for (const chunk of chunks) {
      for (const word of chunk.split(" ")) expect(word).toBe("алгоритмизация");
    }
  });

  it("не теряет символы при нарезке длинного текста", () => {
    const text = Array.from({ length: 400 }, (_, i) => `Пункт ${i}: нужно сделать дело.`).join("\n");
    const chunks = splitTextForMessenger(text, 500);
    expect(dense(chunks.join(""))).toBe(dense(text));
  });

  it("каждый кусок укладывается в лимит", () => {
    const text = "текст ".repeat(5000);
    const chunks = splitTextForMessenger(text, TELEGRAM_TEXT_LIMIT);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
  });

  it("жёстко режет сплошной поток без разделителей", () => {
    const text = "ж".repeat(1000);
    const chunks = splitTextForMessenger(text, 300);
    expect(chunks).toEqual(["ж".repeat(300), "ж".repeat(300), "ж".repeat(300), "ж".repeat(100)]);
  });

  it("не зацикливается на крошечном лимите", () => {
    const chunks = splitTextForMessenger("а б в г д", 1);
    expect(dense(chunks.join(""))).toBe("абвгд");
  });

  it("отвергает неположительный лимит", () => {
    expect(() => splitTextForMessenger("текст", 0)).toThrow();
  });
});
