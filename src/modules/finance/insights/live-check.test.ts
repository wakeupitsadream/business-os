import { beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/core/db";
import { collectFacts } from "./generate";
import { resolvePeriod } from "../period";
import { createTransaction } from "../transactions";
import { assertDisposableDatabase, liveDbEnabled } from "@/core/testing/live-db";

/**
 * Живая проверка фактов на настоящей базе: числа в наблюдениях обязаны
 * совпадать с тем, что вернёт SELECT SUM. Наблюдение с неверной цифрой хуже
 * отсутствующего — оно выглядит как знание.
 */

const NOW = new Date();

describe.runIf(liveDbEnabled)("факты на живой базе", () => {
  beforeAll(async () => {
    // Первой строкой, до любого удаления: ниже идёт deleteMany без условий.
    assertDisposableDatabase();
    await prisma.insight.deleteMany({});
    await prisma.transaction.deleteMany({});

    const month = resolvePeriod("month", NOW);
    const prev = resolvePeriod("prev_month", NOW);
    const inMonth = new Date(month.start.getTime() + 3 * 24 * 3600 * 1000);
    const inPrev = new Date(prev.start.getTime() + 3 * 24 * 3600 * 1000);

    // Прошлый месяц: реклама 10 000.
    await createTransaction({
      type: "EXPENSE",
      amountKop: 10_000_00,
      date: inPrev,
      accountId: "acc_main",
      categoryId: "cat_ads",
      note: "реклама прошлый месяц",
    });
    // Текущий: реклама 40 000 — рост вчетверо.
    await createTransaction({
      type: "EXPENSE",
      amountKop: 40_000_00,
      date: inMonth,
      accountId: "acc_main",
      categoryId: "cat_ads",
      note: "реклама этот месяц",
    });
    await createTransaction({
      type: "INCOME",
      amountKop: 100_000_00,
      date: inMonth,
      accountId: "acc_main",
      categoryId: "cat_subscriptions",
      note: "оплата подписки",
    });
  });

  it("тренд по категории совпадает с базой", async () => {
    const facts = await collectFacts(NOW);
    const trend = facts.find((f) => f.id === "trend:cat_ads");

    expect(trend).toBeDefined();
    expect(trend?.data.amountKop).toBe(40_000_00);
    expect(trend?.data.previousKop).toBe(10_000_00);
    expect(trend?.data.percent).toBe(300);

    const [row] = await prisma.$queryRaw<Array<{ sum: bigint | null }>>`
      SELECT SUM("amountKop")::bigint AS sum FROM "Transaction"
      WHERE "categoryId" = 'cat_ads' AND type = 'EXPENSE'
        AND date >= ${resolvePeriod("month", NOW).start}
    `;
    expect(Number(row?.sum ?? 0)).toBe(trend?.data.amountKop);
  });

  it("прибыль в фактах равна доходам минус расходы", async () => {
    const facts = await collectFacts(NOW);
    const profit = facts.find((f) => f.id === "profit:month");
    expect(profit?.data.profitKop).toBe(100_000_00 - 40_000_00);
  });

  it("факты отсортированы по важности", async () => {
    const facts = await collectFacts(NOW);
    const weights = facts.map((f) => f.weight);
    expect([...weights].sort((a, b) => b - a)).toEqual(weights);
  });

  it("карточка сохраняется с числами-основаниями и не дублируется", async () => {
    // Модель здесь не нужна: проверяем запись и дедуп, а не формулировки.
    const { generateInsights } = await import("./generate");
    vi.spyOn(await import("./phrasing"), "phraseCards").mockResolvedValue([]);

    const first = await generateInsights(NOW);
    const second = await generateInsights(NOW);

    expect(second.created).toBe(0);
    expect(second.skippedExisting).toBe(first.created);
  });
});
