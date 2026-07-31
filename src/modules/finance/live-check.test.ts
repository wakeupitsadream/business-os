import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/core/db";
import { assertDisposableDatabase } from "@/core/testing/live-db";
import { addTransaction, queryFinance } from "./tools/transactions";
import { resolvePeriod } from "./period";
import { accountBalances, computeOverview } from "./metrics";

/**
 * Живая проверка на настоящем PostgreSQL. Запускается только при заданном
 * LIVE_DB=1 — на обычном прогоне пропускается.
 */

const CTX = { runId: "live", channel: "TELEGRAM" as const, now: new Date() };

describe.runIf(process.env.LIVE_DB === "1")("живая база", () => {
  // Этот файл ПИШЕТ операции с источником SECRETARY/TELEGRAM — на боевой базе
  // они неотличимы от настоящих и попадают прямо в KPI владельца. Плюс
  // проверки здесь абсолютные («расход на рекламу за месяц равен 17 000»),
  // поэтому файлу нужна пустая таблица: без неё он падает со второго прогона и
  // от остатков соседних живых тестов. Отсюда и очистка — а раз она есть, то
  // и гейт одноразовой базы перед ней.
  beforeAll(async () => {
    assertDisposableDatabase();
    await prisma.transaction.deleteMany({});
  });

  it("«потратил 3500 на бензин» → операция с категорией «Транспорт»", async () => {
    const res = await addTransaction.execute(
      { direction: "expense", amount: "3500", description: "бензин на заправке" },
      CTX,
    );
    expect(res.ok).toBe(true);

    const tx = await prisma.transaction.findUniqueOrThrow({
      where: { id: res.data?.transactionId as string },
      include: { category: true, account: true },
    });
    expect(tx.amountKop).toBe(350_000);
    expect(tx.category?.name).toBe("Транспорт");
    expect(tx.account.name).toBe("Основная карта");
  });

  it("«сколько ушло на рекламу» совпадает с прямым SQL", async () => {
    await addTransaction.execute(
      { direction: "expense", amount: "12к", description: "реклама в яндекс директ" },
      CTX,
    );
    await addTransaction.execute(
      { direction: "expense", amount: "5 тыс", description: "таргет вконтакте" },
      CTX,
    );

    const res = await queryFinance.execute({ period: "month", category: "реклама" }, CTX);
    const range = resolvePeriod("month", CTX.now);

    const [row] = await prisma.$queryRaw<Array<{ sum: bigint | null }>>`
      SELECT SUM(t."amountKop")::bigint AS sum
      FROM "Transaction" t
      JOIN "Category" c ON c.id = t."categoryId"
      WHERE t.type = 'EXPENSE'
        AND t.date >= ${range.start} AND t.date < ${range.end}
        AND (c.id = 'cat_ads' OR c."parentId" = 'cat_ads')
    `;

    expect(Number(row?.sum ?? 0)).toBe(1_700_000);
    expect(res.data?.amountKop).toBe(Number(row?.sum ?? 0));
  });

  it("итоги месяца сходятся с SELECT SUM по типам", async () => {
    await addTransaction.execute(
      { direction: "income", amount: "40 тыс", description: "оплата подписки клиентом" },
      CTX,
    );

    const res = await queryFinance.execute({ period: "month" }, CTX);
    const range = resolvePeriod("month", CTX.now);

    const rows = await prisma.$queryRaw<Array<{ type: string; sum: bigint }>>`
      SELECT t.type::text AS type, SUM(t."amountKop")::bigint AS sum
      FROM "Transaction" t
      WHERE t.date >= ${range.start} AND t.date < ${range.end}
        AND t.type IN ('INCOME', 'EXPENSE')
      GROUP BY t.type
    `;
    const sql = Object.fromEntries(rows.map((r) => [r.type, Number(r.sum)]));

    expect(res.data?.incomeKop).toBe(sql.INCOME ?? 0);
    expect(res.data?.expenseKop).toBe(sql.EXPENSE ?? 0);
    expect(res.data?.profitKop).toBe((sql.INCOME ?? 0) - (sql.EXPENSE ?? 0));
  });

  it("операция в 02:00 местного первого числа попадает в свой месяц", async () => {
    // Тот самый случай, из-за которого месячный итог расходится с выпиской.
    const range = resolvePeriod("month", CTX.now);
    const justAfterMidnight = new Date(range.start.getTime() + 2 * 3600 * 1000);

    const res = await addTransaction.execute(
      {
        direction: "expense",
        amount: "777",
        description: "ночное такси",
        date: justAfterMidnight.toISOString(),
      },
      CTX,
    );
    expect(res.ok).toBe(true);

    const count = await prisma.transaction.count({
      where: { date: { gte: range.start, lt: range.end }, amountKop: 77_700 },
    });
    expect(count).toBe(1);
  });

  it("KPI экрана сходятся с прямым SQL", async () => {
    // DoD шага: цифры на экране обязаны совпадать с SELECT SUM, иначе это не
    // метрики, а украшение.
    const overview = await computeOverview(CTX.now);
    const range = resolvePeriod("month", CTX.now);

    const rows = await prisma.$queryRaw<Array<{ type: string; sum: bigint }>>`
      SELECT t.type::text AS type, SUM(t."amountKop")::bigint AS sum
      FROM "Transaction" t
      WHERE t.date >= ${range.start} AND t.date < ${range.end}
        AND t.type IN ('INCOME', 'EXPENSE')
      GROUP BY t.type
    `;
    const sql = Object.fromEntries(rows.map((r) => [r.type, Number(r.sum)]));

    expect(overview.current.incomeKop).toBe(sql.INCOME ?? 0);
    expect(overview.current.expenseKop).toBe(sql.EXPENSE ?? 0);
    expect(overview.current.profitKop).toBe((sql.INCOME ?? 0) - (sql.EXPENSE ?? 0));

    // Текущий месяц обязан быть последней точкой ряда и совпадать с KPI.
    const last = overview.series[overview.series.length - 1];
    expect(last?.incomeKop).toBe(overview.current.incomeKop);
    expect(last?.expenseKop).toBe(overview.current.expenseKop);
  });

  it("остаток счёта сходится с SQL, включая переводы", async () => {
    const accounts = await prisma.account.findMany({ select: { id: true, openingBalanceKop: true } });
    const balances = await accountBalances();

    for (const account of accounts) {
      const [row] = await prisma.$queryRaw<Array<{ delta: bigint | null }>>`
        SELECT (
          COALESCE((SELECT SUM("amountKop") FROM "Transaction"
                    WHERE "accountId" = ${account.id} AND type = 'INCOME'), 0)
          - COALESCE((SELECT SUM("amountKop") FROM "Transaction"
                      WHERE "accountId" = ${account.id} AND type IN ('EXPENSE', 'TRANSFER')), 0)
          + COALESCE((SELECT SUM("amountKop") FROM "Transaction"
                      WHERE "transferAccountId" = ${account.id} AND type = 'TRANSFER'), 0)
        )::bigint AS delta
      `;
      const expected = account.openingBalanceKop + Number(row?.delta ?? 0);
      expect(balances.find((b) => b.id === account.id)?.balanceKop).toBe(expected);
    }
  });
});
