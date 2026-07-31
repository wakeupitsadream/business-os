import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StatementRow } from "./types";

/**
 * Классификация строк выписки.
 *
 * Два свойства, ради которых всё это существует. Первое: повторный импорт того
 * же файла обязан давать ноль новых операций. Второе: перевод между своими
 * счетами не должен «находиться» там, где на самом деле два разных платежа на
 * одну сумму, — потерять расход хуже, чем не угадать перевод.
 */

const txFindMany = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const txGroupBy = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const txAggregate = vi.fn(async (..._a: unknown[]) => ({ _sum: { amountKop: 0 } }));
const categoryFindMany = vi.fn(async (..._a: unknown[]) => [] as unknown[]);

vi.mock("@/core/db", () => ({
  prisma: {
    transaction: {
      findMany: (...a: unknown[]) => txFindMany(...a),
      groupBy: (...a: unknown[]) => txGroupBy(...a),
      aggregate: (...a: unknown[]) => txAggregate(...a),
    },
    category: { findMany: (...a: unknown[]) => categoryFindMany(...a) },
  },
}));

const { classifyRows, findTransfer } = await import("./classify");
const { buildDedupKey } = await import("../transactions");

const ACCOUNT = "acc_main";

function row(over: Partial<StatementRow> = {}): StatementRow {
  return {
    date: new Date("2026-07-05T11:00:00Z"),
    amountKop: 350_000,
    type: "EXPENSE",
    description: "АЗС Лукойл",
    mcc: 5541,
    bankCategory: null,
    lineNo: 2,
    ...over,
  };
}

/** Столько операций с таким ключом якобы уже лежит в базе. */
function alreadyInDb(counts: Record<string, number>): void {
  txGroupBy.mockResolvedValue(
    Object.entries(counts).map(([dedupKey, n]) => ({ dedupKey, _count: { _all: n } })),
  );
}

function keyOf(r: StatementRow, accountId = ACCOUNT): string {
  return buildDedupKey({
    accountId,
    date: r.date,
    amountKop: r.amountKop,
    description: r.description,
    type: r.type,
  });
}

/**
 * Столько выручки якобы учтено на счёте ЮKassa, и учтено ДО указанной даты.
 *
 * Через findMany, а не через сумму: остаток считается на дату строки, поэтому
 * коду нужны сами движения. Тот же findMany обслуживает поиск встречных ног
 * перевода — различаем по счёту в условии.
 */
function yookassaBalance(kop: number, at = new Date("2026-07-01T00:00:00Z")): void {
  ledgerAndCandidates(kop === 0 ? [] : [{ date: at, type: "INCOME", amountKop: kop }], candidatesInDb);
}

/** Встречные ноги переводов, лежащие в базе. */
let candidatesInDb: unknown[] = [];

function transferCandidates(rows: unknown[]): void {
  candidatesInDb = rows;
  ledgerAndCandidates([], rows);
}

function ledgerAndCandidates(ledger: unknown[], candidates: unknown[]): void {
  txFindMany.mockImplementation(async (args: unknown) => {
    const where = (args as { where?: { accountId?: unknown } })?.where;
    // Движения счёта ЮKassa и кандидаты на перевод ходят через один findMany —
    // различаем по счёту в условии: у кандидатов там `{ not: ... }`.
    return where?.accountId === "acc_yookassa" ? ledger : candidates;
  });
}

beforeEach(() => {
  txFindMany.mockReset();
  txGroupBy.mockReset();
  txAggregate.mockReset();
  categoryFindMany.mockReset();
  candidatesInDb = [];
  txFindMany.mockResolvedValue([]);
  txGroupBy.mockResolvedValue([]);
  txAggregate.mockResolvedValue({ _sum: { amountKop: 0 } });
  categoryFindMany.mockResolvedValue([]);
});

describe("дедуп", () => {
  it("новая строка — новая", async () => {
    const res = await classifyRows([row()], { accountId: ACCOUNT });
    expect(res.rows[0]?.rowClass).toBe("new");
    expect(res.counts.fresh).toBe(1);
  });

  it("операция, которая уже в базе, помечается дублем", async () => {
    const r = row();
    alreadyInDb({ [keyOf(r)]: 1 });

    const res = await classifyRows([r], { accountId: ACCOUNT });
    expect(res.rows[0]?.rowClass).toBe("duplicate");
    expect(res.counts.duplicates).toBe(1);
  });

  it("две одинаковые законные операции одного дня импортируются обе", async () => {
    // Тот самый дефект: две чашки кофе по 200 ₽ в один день на одном счёте.
    // Различить их нечем — у них совпадает всё, из чего строится ключ, — и
    // раньше вторая молча не импортировалась. Владелец видел только счётчик
    // «Дублей: 1» и не мог узнать, что за ним стоит.
    const res = await classifyRows([row(), row({ lineNo: 3 })], { accountId: ACCOUNT });

    expect(res.rows[0]?.rowClass).toBe("new");
    expect(res.rows[1]?.rowClass).toBe("new");
    expect(res.counts.fresh).toBe(2);
    expect(res.counts.duplicates).toBe(0);
  });

  it("повторная загрузка того же файла не даёт ни одной новой строки", async () => {
    // Инвариант, ради которого ключ и заведён. Он держится счётом, а не
    // уникальным индексом: в базе две операции с этим ключом — значит, две
    // первые строки файла и есть дубли.
    const r = row();
    alreadyInDb({ [keyOf(r)]: 2 });

    const res = await classifyRows([r, row({ lineNo: 3 })], { accountId: ACCOUNT });
    expect(res.counts.fresh).toBe(0);
    expect(res.counts.duplicates).toBe(2);
  });

  it("в файле три одинаковых строки, в базе две — записывается одна", async () => {
    // Проверка того, что счёт именно счёт, а не «видели/не видели»: третья
    // покупка настоящая, и потерять её нельзя.
    const r = row();
    alreadyInDb({ [keyOf(r)]: 2 });

    const res = await classifyRows([r, row({ lineNo: 3 }), row({ lineNo: 4 })], {
      accountId: ACCOUNT,
    });
    expect(res.counts.duplicates).toBe(2);
    expect(res.counts.fresh).toBe(1);
    expect(res.rows[2]?.rowClass).toBe("new");
  });

  it("похожие, но разные операции дублями не считаются", async () => {
    const res = await classifyRows(
      [row(), row({ lineNo: 3, amountKop: 350_001 }), row({ lineNo: 4, description: "АЗС Газпром" })],
      { accountId: ACCOUNT },
    );
    expect(res.counts.duplicates).toBe(0);
  });

  it("возврат по покупке дублем покупки не считается", async () => {
    // Один день, одна сумма, одно описание — различает только направление.
    const res = await classifyRows([row(), row({ lineNo: 3, type: "INCOME" })], {
      accountId: ACCOUNT,
    });
    expect(res.counts.duplicates).toBe(0);
  });
});

describe("вывод эквайринга ЮKassa", () => {
  const payout = (over: Partial<StatementRow> = {}) =>
    row({
      type: "INCOME",
      amountKop: 50_000_00,
      description: "Перевод по договору эквайринга ЮKassa",
      mcc: null,
      ...over,
    });

  it("при учтённой выручке на счёте ЮKassa строка становится выводом, а не доходом", async () => {
    // Тот самый двойной учёт: синк уже записал эту выручку доходом на счёте
    // ЮKassa, и приход в банке — те же деньги, а не новые.
    yookassaBalance(120_000_00);

    const res = await classifyRows([payout()], { accountId: ACCOUNT });
    expect(res.rows[0]?.rowClass).toBe("settlement");
    expect(res.counts.settlements).toBe(1);
    expect(res.counts.fresh).toBe(0);
    // Категория дохода на переводе — мусор, её быть не должно.
    expect(res.rows[0]?.categoryId).toBeNull();
  });

  it("без учтённой выручки строка остаётся доходом", async () => {
    // Синк ЮKassa не настроен — приход в банке единственная запись об этих
    // деньгах. Превратить его в перемещение значило бы обнулить выручку:
    // недоучёт хуже переучёта, потому что заметить его нечем.
    yookassaBalance(0);

    const res = await classifyRows([payout()], { accountId: ACCOUNT });
    expect(res.rows[0]?.rowClass).toBe("new");
    expect(res.rows[0]?.settlementNote).toContain("оставляю доходом");
  });

  it("выручки хватает только на первый из двух выводов", async () => {
    // Запас тратится строка за строкой: два вывода в одной выписке не должны
    // оба опереться на один и тот же остаток.
    yookassaBalance(60_000_00);

    const res = await classifyRows([payout(), payout({ lineNo: 3, amountKop: 50_000_00 })], {
      accountId: ACCOUNT,
    });
    expect(res.rows[0]?.rowClass).toBe("settlement");
    expect(res.rows[1]?.rowClass).toBe("new");
  });

  it("выплата старше учтённой выручки выводом не становится", async () => {
    // Порядок работ владельца: сначала настроить синк (он забирает 90 дней),
    // потом импортировать выписку. Значит, в годовой выписке есть выплаты, чья
    // выручка на счёте ЮKassa не учтена и уже не будет. Сегодняшний остаток их
    // покрыл бы — и прошлогодняя выручка исчезла бы из доходов, а запас,
    // нужный настоящим выплатам этого месяца, был бы съеден.
    yookassaBalance(500_000_00, new Date("2026-07-01T00:00:00Z"));

    const res = await classifyRows([payout({ date: new Date("2025-11-14T10:00:00Z") })], {
      accountId: ACCOUNT,
    });
    expect(res.rows[0]?.rowClass).toBe("new");
    expect(res.rows[0]?.settlementNote).toContain("оставляю доходом");
  });

  it("выплата после учтённой выручки выводом становится", async () => {
    // Контроль к предыдущему: дело именно в дате, а не в сумме.
    yookassaBalance(500_000_00, new Date("2026-07-01T00:00:00Z"));

    const res = await classifyRows([payout({ date: new Date("2026-07-09T10:00:00Z") })], {
      accountId: ACCOUNT,
    });
    expect(res.rows[0]?.rowClass).toBe("settlement");
  });

  it("расход с тем же текстом выводом не считается", async () => {
    // Это комиссия эквайринга, её пишет синк.
    yookassaBalance(120_000_00);

    const res = await classifyRows([payout({ type: "EXPENSE", amountKop: 1_500_00 })], {
      accountId: ACCOUNT,
    });
    expect(res.rows[0]?.rowClass).not.toBe("settlement");
  });

  it("обычный доход выводом не считается", async () => {
    yookassaBalance(120_000_00);

    const res = await classifyRows([payout({ description: "Оплата по счёту 42" })], {
      accountId: ACCOUNT,
    });
    expect(res.rows[0]?.rowClass).toBe("new");
  });

  it("в выписке самого счёта ЮKassa строка не переворачивается", async () => {
    yookassaBalance(120_000_00);

    const res = await classifyRows([payout()], { accountId: "acc_yookassa" });
    expect(res.rows[0]?.rowClass).toBe("new");
  });

  it("вывод, возвращённый владельцем в доходы, при повторе не пишется снова", async () => {
    // Владелец снял галочку — строка легла доходом на счёт выписки, а не
    // переводом. Остаток счёта ЮKassa от этого не изменился, поэтому при
    // повторной загрузке она снова выглядит выводом. Если искать только по
    // ключу вывода, найдётся пусто и те же деньги запишутся второй раз.
    const r = payout();
    yookassaBalance(120_000_00);
    alreadyInDb({ [keyOf(r, ACCOUNT)]: 1 });

    const res = await classifyRows([r], { accountId: ACCOUNT });
    expect(res.rows[0]?.rowClass).toBe("duplicate");
  });

  it("строка, прошедшая доходом из-за нехватки выручки, при повторе тоже дубль", async () => {
    // Зеркальный случай: в прошлый импорт выручки не хватило и строка стала
    // доходом, в этот — хватило. Ключ «текущего» способа записи снова не тот.
    const r = payout();
    yookassaBalance(120_000_00);
    alreadyInDb({ [keyOf(r, ACCOUNT)]: 1, [keyOf(r, "acc_yookassa")]: 0 });

    const res = await classifyRows([r], { accountId: ACCOUNT });
    expect(res.rows[0]?.rowClass).toBe("duplicate");
  });

  it("две законные выплаты в файле при одной уже импортированной", async () => {
    // Счёт остаётся счётом и для выводов: одна из двух — дубль, вторая новая.
    const r = payout();
    yookassaBalance(200_000_00);
    alreadyInDb({ [keyOf(r, "acc_yookassa")]: 1 });

    const res = await classifyRows([r, payout({ lineNo: 3 })], { accountId: ACCOUNT });
    expect(res.rows[0]?.rowClass).toBe("duplicate");
    expect(res.rows[1]?.rowClass).toBe("settlement");
  });

  it("повторный импорт не создаёт второй вывод", async () => {
    // Ключ дедупа вывода считается от счёта ЮKassa — того, на который строка
    // ляжет. Иначе повторная загрузка искала бы его не на том счёте и
    // создавала бы вывод заново при каждом импорте.
    const r = payout();
    yookassaBalance(120_000_00);
    alreadyInDb({ [keyOf(r, "acc_yookassa")]: 1 });

    const res = await classifyRows([r], { accountId: ACCOUNT });
    expect(res.rows[0]?.rowClass).toBe("duplicate");
  });
});

describe("внутренние переводы", () => {
  const candidate = (over: Partial<Record<string, unknown>> = {}) => ({
    id: "tx_other",
    accountId: "acc_cash",
    accountName: "Наличные",
    type: "INCOME" as const,
    date: new Date("2026-07-05T11:00:00Z"),
    amountKop: 350_000,
    text: "",
    ...over,
  });

  it("зеркальная пара на другом счёте распознаётся", () => {
    const verdict = findTransfer(row(), [candidate()], new Set());
    expect(verdict.kind).toBe("found");
  });

  it("два кандидата — не предлагаем ничего", () => {
    // Ровно тот случай, ради которого правило и заведено: два одинаковых
    // платежа подрядчику выглядят как перевод между своими счетами.
    const verdict = findTransfer(
      row(),
      [candidate(), candidate({ id: "tx_third" })],
      new Set(),
    );
    expect(verdict.kind).toBe("ambiguous");
  });

  it("одну встречную ногу не могут занять две строки файла", () => {
    const taken = new Set(["tx_other"]);
    expect(findTransfer(row(), [candidate()], taken).kind).toBe("none");
  });

  it("та же сумма, но то же направление — не перевод", () => {
    expect(findTransfer(row(), [candidate({ type: "EXPENSE" })], new Set()).kind).toBe("none");
  });

  it("другая сумма — не перевод", () => {
    expect(findTransfer(row(), [candidate({ amountKop: 350_001 })], new Set()).kind).toBe("none");
  });

  it("через два дня — не перевод", () => {
    const far = candidate({ date: new Date("2026-07-08T11:00:00Z") });
    expect(findTransfer(row(), [far], new Set()).kind).toBe("none");
  });

  it("окно ±1 день режется по московским суткам", () => {
    // Списание 01.08 в 00:30 и зачисление 31.07 в 23:30 по местному — соседние
    // дни владельца, пара обязана находиться.
    const late = row({ date: new Date("2026-07-31T21:30:00Z") }); // 02:30 местного 1 августа
    const counter = candidate({ date: new Date("2026-07-31T20:30:00Z") }); // 01:30 местного 1 августа
    expect(findTransfer(late, [counter], new Set()).kind).toBe("found");
  });

  it("слово «перевод» в описании поднимает уверенность", () => {
    const verdict = findTransfer(
      row({ description: "Перевод на свою карту" }),
      [candidate()],
      new Set(),
    );
    expect(verdict.kind === "found" && verdict.confidence).toBe("high");
  });

  it("без текстовых признаков уверенность низкая", () => {
    const verdict = findTransfer(row(), [candidate()], new Set());
    expect(verdict.kind === "found" && verdict.confidence).toBe("low");
  });
});

describe("неоднозначность в общем разборе", () => {
  it("строка остаётся новой и получает пояснение", async () => {
    transferCandidates([
      {
        id: "a",
        accountId: "acc_cash",
        type: "INCOME",
        date: new Date("2026-07-05T11:00:00Z"),
        amountKop: 350_000,
        note: null,
        counterparty: null,
        account: { name: "Наличные" },
      },
      {
        id: "b",
        accountId: "acc_cash",
        type: "INCOME",
        date: new Date("2026-07-05T12:00:00Z"),
        amountKop: 350_000,
        note: null,
        counterparty: null,
        account: { name: "Наличные" },
      },
    ]);

    const res = await classifyRows([row()], { accountId: ACCOUNT });
    expect(res.rows[0]?.rowClass).toBe("new");
    expect(res.rows[0]?.transferNote).toContain("2");
  });
});
