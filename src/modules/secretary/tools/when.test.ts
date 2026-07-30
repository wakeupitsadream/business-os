import { describe, it, expect } from "vitest";
import { parseWhen } from "./when";

const NOW = new Date("2026-07-29T09:00:00Z"); // 12:00 МСК

describe("корректное время принимается", () => {
  it("ISO со смещением владельца", () => {
    const r = parseWhen("2026-07-30T10:00:00+03:00", NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.date.toISOString()).toBe("2026-07-30T07:00:00.000Z");
  });

  it("ISO в UTC с суффиксом Z", () => {
    const r = parseWhen("2026-07-30T07:00:00Z", NOW);
    expect(r.ok).toBe(true);
  });

  it("смещение без двоеточия", () => {
    expect(parseWhen("2026-07-30T10:00:00+0300", NOW).ok).toBe(true);
  });

  it("ближайшие минуты — это нормально", () => {
    expect(parseWhen(new Date(NOW.getTime() + 60_000).toISOString(), NOW).ok).toBe(true);
  });
});

describe("время без часового пояса отклоняется", () => {
  it("иначе строка читается как UTC и напоминание уезжает на три часа", () => {
    const r = parseWhen("2026-07-30T10:00:00", NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("часовой пояс");
  });

  it("голая дата тоже без пояса", () => {
    expect(parseWhen("2026-07-30", NOW).ok).toBe(false);
  });
});

describe("время в прошлом отклоняется", () => {
  it("модель посчитала от даты своего обучения", () => {
    const r = parseWhen("2024-01-01T10:00:00+03:00", NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/прошл/);
  });

  it("но секунды на исполнение прощаются", () => {
    // Пока модель думала и инструмент исполнялся, прошло время: «через минуту»
    // не должно отвергаться из-за этого.
    const justPassed = new Date(NOW.getTime() - 30_000).toISOString();
    expect(parseWhen(justPassed, NOW).ok).toBe(true);
  });
});

describe("абсурдные значения отклоняются", () => {
  it("не разбираемая строка", () => {
    const r = parseWhen("когда-нибудь потом", NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ISO 8601");
  });

  it("пустая строка", () => {
    expect(parseWhen("   ", NOW).ok).toBe(false);
  });

  it("слишком далеко в будущем", () => {
    const r = parseWhen("2099-01-01T10:00:00+03:00", NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/далеко/);
  });
});

describe("сообщения об ошибке пригодны для второй попытки модели", () => {
  it("подсказывают ожидаемый формат", () => {
    const r = parseWhen("2026-07-30T10:00:00", NOW);
    if (!r.ok) expect(r.error).toMatch(/\+03:00/);
  });
});
