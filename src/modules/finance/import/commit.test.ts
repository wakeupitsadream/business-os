import { describe, expect, it } from "vitest";
import { planRows, type CommitDecision } from "./commit";
import { checkControlSum, fingerprintRows } from "./batch";
import type { ClassifiedRow } from "./classify";
import type { ParseResult } from "./types";

/**
 * План записи и контрольная сверка — то, что решает, какие деньги попадут в
 * базу. Проверяется главное свойство: клиент может только убрать строку и
 * сменить категорию, но не может продиктовать сумму.
 */

function row(over: Partial<ClassifiedRow> = {}): ClassifiedRow {
  return {
    index: 0,
    lineNo: 2,
    date: "2026-07-05T11:00:00.000Z",
    amountKop: 350_000,
    type: "EXPENSE",
    description: "АЗС Лукойл",
    mcc: 5541,
    dedupKey: "key0",
    rowClass: "new",
    categoryId: "cat_transport",
    categoryName: "Транспорт",
    categoryVia: "mcc",
    ...over,
  };
}

const decisions = (list: CommitDecision[]) => new Map(list.map((d) => [d.index, d]));

describe("план записи", () => {
  it("по умолчанию пишутся все новые строки со своими категориями", () => {
    const plan = planRows([row(), row({ index: 1, dedupKey: "key1" })], decisions([]));
    expect(plan.toWrite).toHaveLength(2);
    expect(plan.toWrite[0]?.categoryId).toBe("cat_transport");
  });

  it("снятая галочка убирает строку", () => {
    const plan = planRows([row()], decisions([{ index: 0, include: false }]));
    expect(plan.toWrite).toHaveLength(0);
  });

  it("клиент может сменить категорию", () => {
    const plan = planRows([row()], decisions([{ index: 0, include: true, categoryId: "cat_food" }]));
    expect(plan.toWrite[0]?.categoryId).toBe("cat_food");
  });

  it("клиент может убрать категорию совсем", () => {
    const plan = planRows([row()], decisions([{ index: 0, include: true, categoryId: null }]));
    expect(plan.toWrite[0]?.categoryId).toBeNull();
  });

  it("сумма и дата берутся из разбора, что бы ни прислал клиент", () => {
    // В решении нет полей суммы и даты вовсе — это и есть защита: подделать
    // нечего. Тест фиксирует, что план строится по строке, а не по решению.
    const plan = planRows(
      [row()],
      decisions([{ index: 0, include: true } as CommitDecision & { amountKop?: number }]),
    );
    expect(plan.toWrite[0]?.row.amountKop).toBe(350_000);
    expect(plan.toWrite[0]?.row.date).toBe("2026-07-05T11:00:00.000Z");
  });

  it("дубль не пишется даже по прямой просьбе клиента", () => {
    // Уникальный индекс всё равно бы его отверг — лучше отвергнуть осмысленно
    // и до открытия транзакции.
    const plan = planRows([row({ rowClass: "duplicate" })], decisions([{ index: 0, include: true }]));
    expect(plan.toWrite).toHaveLength(0);
    expect(plan.duplicates).toBe(1);
  });

  it("решение с несуществующим индексом ничего не ломает", () => {
    const plan = planRows([row()], decisions([{ index: 99, include: false }]));
    expect(plan.toWrite).toHaveLength(1);
  });
});

describe("перевод", () => {
  const transferRow = row({
    rowClass: "transfer",
    counterpartId: "tx_other",
    transferConfidence: "high",
  });

  it("по умолчанию импортируется как обычная операция", () => {
    // Не «пропустить»: встречная нога уже лежит в базе расходом, и молча
    // пропустить приход значит занизить прибыль на сумму перевода.
    const plan = planRows([transferRow], decisions([]));
    expect(plan.toWrite).toHaveLength(1);
    expect(plan.toMerge).toHaveLength(0);
  });

  it("по явному решению сводится со встречной операцией", () => {
    const plan = planRows([transferRow], decisions([{ index: 0, include: true, mergeTransfer: true }]));
    expect(plan.toWrite).toHaveLength(0);
    expect(plan.toMerge[0]?.counterpartId).toBe("tx_other");
  });

  it("без встречной операции слияние невозможно", () => {
    const orphan = row({ rowClass: "transfer", counterpartId: null });
    const plan = planRows([orphan], decisions([{ index: 0, include: true, mergeTransfer: true }]));
    expect(plan.toWrite).toHaveLength(1);
  });
});

describe("отпечаток предпросмотра", () => {
  it("одинаков для одного и того же разбора", () => {
    expect(fingerprintRows([row()])).toBe(fingerprintRows([row()]));
  });

  it("меняется, если изменилась сумма", () => {
    expect(fingerprintRows([row({ amountKop: 1 })])).not.toBe(fingerprintRows([row()]));
  });

  it("меняется, если строка перестала быть новой", () => {
    // Операция могла приехать другим путём между предпросмотром и коммитом.
    expect(fingerprintRows([row({ rowClass: "duplicate" })])).not.toBe(fingerprintRows([row()]));
  });

  it("не зависит от выбранной категории", () => {
    // Смена категории — законное решение владельца, а не устаревание разбора.
    expect(fingerprintRows([row({ categoryId: "cat_food" })])).toBe(fingerprintRows([row()]));
  });
});

describe("контрольная сверка", () => {
  const parsed = (totals: ParseResult["declaredTotals"]): ParseResult => ({
    rows: [],
    declaredTotals: totals,
    skipped: [],
    pending: 0,
  });

  it("итогов нет — «сверять не с чем», а не «сошлось»", () => {
    const res = checkControlSum(parsed(null), { incomeKop: 100, expenseKop: 50 });
    expect(res.status).toBe("not_available");
  });

  it("итоги сошлись", () => {
    const res = checkControlSum(parsed({ incomeKop: 100, expenseKop: 50 }), {
      incomeKop: 100,
      expenseKop: 50,
    });
    expect(res.status).toBe("matched");
  });

  it("расхождение в одну копейку — уже расхождение", () => {
    const res = checkControlSum(parsed({ incomeKop: 100, expenseKop: 50 }), {
      incomeKop: 100,
      expenseKop: 51,
    });
    expect(res.status).toBe("mismatch");
    expect(res.deltaKop).toBe(-1);
  });
});
