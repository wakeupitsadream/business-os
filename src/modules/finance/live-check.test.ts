import { describe, expect, it } from "vitest";
import { prisma } from "@/core/db";
import { addTransaction, queryFinance } from "./tools/transactions";
import { resolvePeriod } from "./period";

/**
 * Живая проверка на настоящем PostgreSQL. Запускается только при заданном
 * LIVE_DB=1 — на обычном прогоне пропускается.
 */

const CTX = { runId: "live", channel: "TELEGRAM" as const, now: new Date() };

describe.runIf(process.env.LIVE_DB === "1")("живая база", () => {
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

  it("операция в 02:00 МСК первого числа попадает в свой месяц", async () => {
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
});
