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
const categoryFindMany = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
/** Есть ли платежи на счёте ЮKassa — от этого зависит разбор поступлений. */
const txFindFirst = vi.fn(async (..._a: unknown[]) => null as unknown);

vi.mock("@/core/db", () => ({
  prisma: {
    transaction: {
      findMany: (...a: unknown[]) => txFindMany(...a),
      // Без заглушки разбор падал бы на каждом тесте файла: проверка
      // активности ЮKassa ходит именно сюда.
      findFirst: (...a: unknown[]) => txFindFirst(...a),
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

beforeEach(() => {
  txFindMany.mockReset();
  categoryFindMany.mockReset();
  txFindFirst.mockReset();
  txFindMany.mockResolvedValue([]);
  categoryFindMany.mockResolvedValue([]);
  txFindFirst.mockResolvedValue(null); // ЮKassa по умолчанию не работала
});

describe("дедуп", () => {
  it("новая строка — новая", async () => {
    const res = await classifyRows([row()], { accountId: ACCOUNT });
    expect(res.rows[0]?.rowClass).toBe("new");
    expect(res.counts.fresh).toBe(1);
  });

  it("операция, которая уже в базе, помечается дублем", async () => {
    const r = row();
    const key = buildDedupKey({
      accountId: ACCOUNT,
      date: r.date,
      amountKop: r.amountKop,
      description: r.description,
      type: r.type,
    });
    // Первый findMany — существующие ключи, второй — кандидаты на перевод.
    txFindMany.mockResolvedValueOnce([{ dedupKey: key }]).mockResolvedValueOnce([]);

    const res = await classifyRows([r], { accountId: ACCOUNT });
    expect(res.rows[0]?.rowClass).toBe("duplicate");
    expect(res.counts.duplicates).toBe(1);
  });

  it("две одинаковые строки ВНУТРИ файла — обе операции, а не дубль", async () => {
    // Две заправки по 3500 ₽ за день — законная пара. Раньше вторая получала
    // хэш первой и молча пропадала: владелец не видел её ни в операциях, ни в
    // пропусках и вернуть не мог. Отличить настоящий повтор от дважды
    // выгруженной банком строки система не умеет, поэтому берёт обе и говорит
    // об этом: видимая лишняя строка лучше невидимой потерянной.
    const res = await classifyRows([row(), row({ lineNo: 3 })], { accountId: ACCOUNT });
    expect(res.rows[0]?.rowClass).toBe("new");
    expect(res.rows[1]?.rowClass).toBe("new");
    expect(res.counts.fresh).toBe(2);
  });

  it("повтор получает СВОЙ ключ, иначе коммит упал бы на уникальном индексе", async () => {
    const res = await classifyRows([row(), row({ lineNo: 3 })], { accountId: ACCOUNT });
    expect(res.rows[0]?.dedupKey).not.toBe(res.rows[1]?.dedupKey);
  });

  it("повтор помечается для владельца и ссылается на исходную строку", async () => {
    const res = await classifyRows([row(), row({ lineNo: 3 })], { accountId: ACCOUNT });
    expect(res.rows[0]?.repeatNote).toBeUndefined();
    expect(res.rows[1]?.repeatNote).toContain("2");
  });

  it("три одинаковых строки дают три разных ключа", async () => {
    const res = await classifyRows([row(), row({ lineNo: 3 }), row({ lineNo: 4 })], {
      accountId: ACCOUNT,
    });
    expect(new Set(res.rows.map((r) => r.dedupKey)).size).toBe(3);
  });

  it("повторная загрузка того же файла даёт ноль новых строк", async () => {
    // Свойство, ради которого ключ и существует. Нумерация повторов не должна
    // его сломать: номер считается по составу файла, а файл тот же.
    const first = await classifyRows([row(), row({ lineNo: 3 })], { accountId: ACCOUNT });
    const keys = first.rows.map((r) => r.dedupKey);

    txFindMany
      .mockResolvedValueOnce(keys.map((dedupKey) => ({ dedupKey })))
      .mockResolvedValueOnce([]);

    const second = await classifyRows([row(), row({ lineNo: 3 })], { accountId: ACCOUNT });
    expect(second.counts.duplicates).toBe(2);
    expect(second.counts.fresh).toBe(0);
  });

  it("ключ первого повторения не изменился — уже импортированное не станет новым", async () => {
    // Смена формата ключа пометила бы всё ранее загруженное как новое, и
    // повторный импорт задвоил бы историю.
    const r = row();
    const asBefore = buildDedupKey({
      accountId: ACCOUNT,
      date: r.date,
      amountKop: r.amountKop,
      description: r.description,
      type: r.type,
    });
    const res = await classifyRows([r], { accountId: ACCOUNT });
    expect(res.rows[0]?.dedupKey).toBe(asBefore);
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

describe("поступление с ЮKassa", () => {
  /**
   * Перевод собственных денег с ЮKassa на банковский счёт — не выручка: те же
   * деньги уже посчитаны платежами клиентов, которые записал синк. Записать
   * поступление доходом значит удвоить месячную выручку, причём незаметно:
   * цифра выглядит правдоподобно.
   *
   * Но обратная ошибка страшнее. Если синк не работал, это поступление —
   * единственная запись об этих деньгах, и превращать его в перевод нельзя:
   * выручка исчезнет из учёта совсем.
   */
  const settlement = (over: Partial<StatementRow> = {}) =>
    row({ type: "INCOME", description: "Перевод от ЮKassa", amountKop: 4_500_000, ...over });

  it("при работающем синке становится переводом, а не доходом", async () => {
    txFindFirst.mockResolvedValue({ id: "tx_yoo" }); // на счёте ЮKassa есть платежи

    const res = await classifyRows([settlement()], { accountId: ACCOUNT });
    expect(res.rows[0]?.rowClass).toBe("settlement");
    expect(res.rows[0]?.settlementNote).toBeTruthy();
    expect(res.counts.settlements).toBe(1);
  });

  it("без платежей на счёте ЮKassa остаётся доходом", async () => {
    // Иначе единственная запись о деньгах превратилась бы в перевод «ниоткуда»
    // и выручка пропала бы вовсе.
    const res = await classifyRows([settlement()], { accountId: ACCOUNT });
    expect(res.rows[0]?.rowClass).toBe("new");
    expect(res.counts.settlements).toBe(0);
  });

  it("расход в адрес ЮKassa переводом не считается", async () => {
    // Комиссия или возврат — это настоящий расход, а не движение своих денег.
    txFindFirst.mockResolvedValue({ id: "tx_yoo" });
    const res = await classifyRows([settlement({ type: "EXPENSE" })], { accountId: ACCOUNT });
    expect(res.rows[0]?.rowClass).not.toBe("settlement");
  });

  it("обычный доход не трогается", async () => {
    txFindFirst.mockResolvedValue({ id: "tx_yoo" });
    const res = await classifyRows(
      [row({ type: "INCOME", description: 'Оплата от ООО "Ромашка"' })],
      { accountId: ACCOUNT },
    );
    expect(res.rows[0]?.rowClass).toBe("new");
  });

  it("узнаётся в разных написаниях", async () => {
    txFindFirst.mockResolvedValue({ id: "tx_yoo" });
    for (const text of ["ЮKassa", "юкасса", "YooMoney", "YOOKASSA", "ЮMoney"]) {
      const res = await classifyRows([settlement({ description: `Перевод ${text}` })], {
        accountId: ACCOUNT,
      });
      expect(res.rows[0]?.rowClass, text).toBe("settlement");
    }
  });

  it("разбор выписки самого счёта ЮKassa не сводит строки сами в себя", async () => {
    txFindFirst.mockResolvedValue({ id: "tx_yoo" });
    const res = await classifyRows([settlement()], { accountId: "acc_yookassa" });
    expect(res.rows[0]?.rowClass).toBe("new");
  });

  it("уже импортированное поступление считается дублем", async () => {
    // Перевод ложится на счёт ЮKassa, а не на счёт выписки. Поиск дублей
    // обязан его находить, иначе повторный импорт создаст его заново.
    txFindFirst.mockResolvedValue({ id: "tx_yoo" });
    const r = settlement();
    const key = buildDedupKey({
      accountId: ACCOUNT,
      date: r.date,
      amountKop: r.amountKop,
      description: r.description,
      type: r.type,
    });
    txFindMany.mockResolvedValueOnce([{ dedupKey: key }]).mockResolvedValueOnce([]);

    const res = await classifyRows([r], { accountId: ACCOUNT });
    expect(res.rows[0]?.rowClass).toBe("duplicate");
  });
});

describe("неоднозначность в общем разборе", () => {
  it("строка остаётся новой и получает пояснение", async () => {
    txFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
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
