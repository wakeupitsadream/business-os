import { describe, expect, it } from "vitest";
import { previewText } from "./telegram-import";
import type { ImportStats } from "./batch";
import type { ClassifiedRow } from "./classify";

/**
 * Предпросмотр выписки в чате.
 *
 * Показать всё нельзя: выписка на триста строк превращается в несколько
 * экранов, которые пролистают не читая, и подтверждение вслепую становится
 * нормой. Но и молчать нельзя — дубли, повторы и поступления с ЮKassa НЕ
 * переводят партию в NEEDS_REVIEW, то есть без явного упоминания исчезают из
 * поля зрения совсем. Эти тесты про то, что важное названо.
 */

const BASE: ImportStats = {
  accountId: "acc_main",
  accountName: "Основная карта",
  bank: "tbank",
  bankLabel: "Т-Банк",
  encoding: "windows-1251",
  total: 10,
  fresh: 8,
  duplicates: 2,
  transfers: 0,
  settlements: 0,
  pending: 0,
  skipped: [],
  incomeKop: 4_000_000,
  expenseKop: 1_900_750,
  controlSum: { status: "not_available" },
  controlSumOk: null,
  fingerprint: "a".repeat(64),
  headerFingerprint: "h".repeat(16),
};

function row(over: Partial<ClassifiedRow> = {}): ClassifiedRow {
  return {
    index: 0,
    lineNo: 2,
    date: "2026-07-05T11:00:00.000Z",
    amountKop: 350_000,
    type: "EXPENSE",
    description: "АЗС Лукойл",
    mcc: 5541,
    dedupKey: "k",
    rowClass: "new",
    categoryId: null,
    categoryName: null,
    categoryVia: null,
    ...over,
  };
}

describe("что владелец видит перед подтверждением", () => {
  it("счёт назван — иначе ошибка выбора счёта незаметна", () => {
    // Счёт в чате не выбирают, его подставляет система. Молча — значит вся
    // выписка может лечь не туда, и заметить это будет нечем.
    expect(previewText(BASE, [], "Основная карта", "PREVIEW")).toContain("Основная карта");
  });

  it("сумма новых операций и число дублей названы", () => {
    const text = previewText(BASE, [], "Основная карта", "PREVIEW");
    expect(text).toContain("Новых операций: 8");
    expect(text).toContain("Уже импортированы раньше: 2");
  });

  it("поступления с ЮKassa названы отдельно и объяснены", () => {
    // Они не попадают в NEEDS_REVIEW, а меняют смысл цифр сильнее всего:
    // владелец должен понимать, почему выручка не выросла.
    const text = previewText({ ...BASE, settlements: 1 }, [], "Основная карта", "PREVIEW");
    expect(text).toContain("ЮKassa");
    expect(text).toMatch(/переводом/i);
  });

  it("полные повторы внутри файла названы", () => {
    const rows = [row(), row({ index: 1, repeatNote: "Повторяет строку 2" })];
    const text = previewText(BASE, rows, "Основная карта", "PREVIEW");
    expect(text).toMatch(/повтор/i);
  });

  it("нечитаемые строки не замалчиваются", () => {
    const stats = { ...BASE, skipped: [{ lineNo: 7, reason: "мусорная сумма" }] };
    expect(previewText(stats, [], "Основная карта", "PREVIEW")).toMatch(/разобрать/i);
  });

  it("расхождение контрольной суммы выделено предупреждением", () => {
    const stats: ImportStats = {
      ...BASE,
      controlSum: { status: "mismatch", declaredKop: 1, computedKop: 2, deltaKop: 1 },
      controlSumOk: false,
    };
    expect(previewText(stats, [], "Основная карта", "PREVIEW")).toContain("⚠️");
  });

  it("статус NEEDS_REVIEW объяснён словами, а не кодом", () => {
    const text = previewText(BASE, [], "Основная карта", "NEEDS_REVIEW");
    expect(text).toMatch(/непрочитанные строки/i);
    expect(text).not.toContain("NEEDS_REVIEW");
  });

  it("показывается несколько строк для узнавания файла, но не все", () => {
    const rows = Array.from({ length: 40 }, (_, i) => row({ index: i, lineNo: i + 2 }));
    const text = previewText({ ...BASE, total: 40 }, rows, "Основная карта", "PREVIEW");
    expect(text).toContain("Лукойл");
    expect(text).toMatch(/и ещё \d+/);
    // Сорок строк в одно сообщение не влезут осмысленно.
    expect(text.split("\n").length).toBeLessThan(30);
  });

  it("дубли в образец не попадают — показывать надо то, что запишется", () => {
    const rows = [row({ rowClass: "duplicate", description: "Старая операция" }), row({ index: 1 })];
    const text = previewText(BASE, rows, "Основная карта", "PREVIEW");
    expect(text).not.toContain("Старая операция");
  });

  it("влезает в одно сообщение Telegram", () => {
    const rows = Array.from({ length: 40 }, (_, i) => row({ index: i }));
    expect(previewText(BASE, rows, "Основная карта", "PREVIEW").length).toBeLessThan(4096);
  });
});
