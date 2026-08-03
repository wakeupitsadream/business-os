import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Сводка HQ.
 *
 * Главное свойство экрана: он нужен ровно тогда, когда что-то сломалось.
 * Поэтому все тесты ниже — про то, что отказ одного блока не уносит остальные
 * и что «не знаем» не превращается в ноль.
 */

const financeOverview = vi.fn(async (..._a: unknown[]) => ({}) as unknown);
const salesOverview = vi.fn(async (..._a: unknown[]) => ({}) as unknown);
const spentToday = vi.fn(async () => 0);
const budgetKop = vi.fn(() => 0);

const taskCount = vi.fn(async (..._a: unknown[]) => 0);
const eventFindMany = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const runFindMany = vi.fn(async (..._a: unknown[]) => [] as unknown[]);

vi.mock("@/modules/finance/metrics", () => ({
  computeOverview: (...a: unknown[]) => financeOverview(...a),
}));
vi.mock("@/modules/sales/metrics", () => ({
  computeOverview: (...a: unknown[]) => salesOverview(...a),
}));
vi.mock("@/core/llm/usage", () => ({
  llmSpentTodayKop: () => spentToday(),
  llmDailyBudgetKop: () => budgetKop(),
}));
vi.mock("@/core/db", () => ({
  prisma: {
    task: { count: (...a: unknown[]) => taskCount(...a) },
    domainEvent: { findMany: (...a: unknown[]) => eventFindMany(...a) },
    agentRun: { findMany: (...a: unknown[]) => runFindMany(...a) },
  },
}));

const { collectHqOverview } = await import("./overview");

const NOW = new Date("2026-08-03T09:00:00Z");

const FINANCE_OK = {
  current: { incomeKop: 12_000_00, expenseKop: 0, profitKop: 0 },
  revenueChangePct: 12.4,
};
const SALES_OK = { activeDeals: 7, weightedAmountKop: 350_000_00 };

beforeEach(() => {
  financeOverview.mockReset().mockResolvedValue(FINANCE_OK);
  salesOverview.mockReset().mockResolvedValue(SALES_OK);
  spentToday.mockReset().mockResolvedValue(4_50);
  budgetKop.mockReset().mockReturnValue(0);
  taskCount.mockReset().mockResolvedValue(0);
  eventFindMany.mockReset().mockResolvedValue([]);
  runFindMany.mockReset().mockResolvedValue([]);
});

describe("сводка собирается", () => {
  it("цифры берутся из готовых метрик отделов, а не считаются заново", async () => {
    const hq = await collectHqOverview(NOW);

    expect(hq.revenueKop.value).toBe(12_000_00);
    expect(hq.activeDeals.value).toBe(7);
    expect(hq.failed).toEqual([]);
  });

  it("подсказка к выручке называет изменение к прошлому месяцу", async () => {
    const hq = await collectHqOverview(NOW);
    expect(hq.revenueKop.hint).toContain("12%");
  });

  it("системные события в ленту не идут", async () => {
    await collectHqOverview(NOW);
    const where = (eventFindMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
    // Они про то, как работает машина, а не про то, как идут дела.
    expect(where.module).toEqual({ not: "system" });
  });
});

describe("отказ одного блока не уносит остальные", () => {
  it("упавшие финансы оставляют продажи на месте", async () => {
    financeOverview.mockRejectedValue(new Error("база недоступна"));

    const hq = await collectHqOverview(NOW);

    expect(hq.revenueKop.value).toBeNull();
    expect(hq.activeDeals.value).toBe(7);
    expect(hq.failed).toContain("Финансы");
  });

  it("«не знаем» не превращается в ноль", async () => {
    // Ноль читается как факт: «выручки за месяц не было». Это ложь, и по ней
    // владелец примет решение.
    salesOverview.mockRejectedValue(new Error("таймаут"));

    const hq = await collectHqOverview(NOW);

    expect(hq.activeDeals.value).toBeNull();
    expect(hq.activeDeals.value).not.toBe(0);
  });

  it("отказ всех блоков сразу не роняет экран", async () => {
    financeOverview.mockRejectedValue(new Error("нет базы"));
    salesOverview.mockRejectedValue(new Error("нет базы"));
    taskCount.mockRejectedValue(new Error("нет базы"));
    spentToday.mockRejectedValue(new Error("нет базы"));
    eventFindMany.mockRejectedValue(new Error("нет базы"));
    runFindMany.mockRejectedValue(new Error("нет базы"));

    const hq = await collectHqOverview(NOW);

    expect(hq.failed).toHaveLength(6);
    expect(hq.feed).toEqual([]);
    expect(hq.runs).toEqual([]);
  });
});

describe("расход на модели", () => {
  it("без лимита подсказка так и говорит", async () => {
    const hq = await collectHqOverview(NOW);
    expect(hq.llmBudgetKop).toBe(0);
    expect(hq.llmSpendKop.hint).toContain("не задан");
  });

  it("с лимитом подсказка называет его", async () => {
    budgetKop.mockReturnValue(200_00);
    const hq = await collectHqOverview(NOW);
    expect(hq.llmSpendKop.hint).toContain("200");
  });
});

describe("задачи", () => {
  it("просроченные считаются отдельно от сегодняшних", async () => {
    taskCount.mockResolvedValueOnce(3).mockResolvedValueOnce(2);

    const hq = await collectHqOverview(NOW);

    expect(hq.tasksToday.value).toBe(3);
    expect(hq.tasksToday.hint).toContain("2");
  });
});
