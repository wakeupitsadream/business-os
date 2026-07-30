import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Метрики. Проверяется то, что легко посчитать неверно и трудно заметить:
 * остаток счёта при переводах, runway на неполном месяце, границы месяцев в
 * ряду для графика.
 */

const accountFindMany = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const txGroupBy = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const categoryFindMany = vi.fn(async (..._a: unknown[]) => [] as unknown[]);

vi.mock("@/core/db", () => ({
  prisma: {
    account: { findMany: (...a: unknown[]) => accountFindMany(...a) },
    transaction: { groupBy: (...a: unknown[]) => txGroupBy(...a) },
    category: { findMany: (...a: unknown[]) => categoryFindMany(...a) },
  },
}));

const { accountBalances, computeRunwayMonths, monthlySeries } = await import("./metrics");

beforeEach(() => {
  accountFindMany.mockReset();
  txGroupBy.mockReset();
  categoryFindMany.mockReset();
  accountFindMany.mockResolvedValue([]);
  txGroupBy.mockResolvedValue([]);
  categoryFindMany.mockResolvedValue([]);
});

describe("runway", () => {
  const month = (incomeKop: number, expenseKop: number) => ({ incomeKop, expenseKop });

  it("считает по среднему чистому расходу за окно", () => {
    // Средний burn = (100 000 − 40 000) = 60 000 ₽/мес при остатке 180 000 ₽.
    const months = [month(40_000_00, 100_000_00), month(40_000_00, 100_000_00), month(40_000_00, 100_000_00)];
    expect(computeRunwayMonths(180_000_00, months)).toBeCloseTo(3, 5);
  });

  it("прибыльный бизнес не имеет runway — и это не «∞»", () => {
    // «∞» на экране читается как обещание, а доход может кончиться.
    const months = [month(200_000_00, 100_000_00), month(200_000_00, 100_000_00)];
    expect(computeRunwayMonths(500_000_00, months)).toBeNull();
  });

  it("нулевой остаток при убыли даёт ноль, а не отрицательное число", () => {
    expect(computeRunwayMonths(0, [month(0, 100_000_00)])).toBe(0);
    expect(computeRunwayMonths(-5_000_00, [month(0, 100_000_00)])).toBe(0);
  });

  it("без истории runway не определён", () => {
    expect(computeRunwayMonths(500_000_00, [])).toBeNull();
  });

  it("берёт только последние месяцы окна", () => {
    // Давний месяц с огромным расходом не должен вечно портить оценку.
    const months = [month(0, 1_000_000_00), month(50_000_00, 60_000_00), month(50_000_00, 60_000_00), month(50_000_00, 60_000_00)];
    expect(computeRunwayMonths(30_000_00, months, 3)).toBeCloseTo(3, 5);
  });
});

describe("остатки по счетам", () => {
  it("перевод уменьшает один счёт и увеличивает другой", () => {
    accountFindMany.mockResolvedValue([
      { id: "a", name: "Карта", openingBalanceKop: 100_000_00 },
      { id: "b", name: "Наличные", openingBalanceKop: 0 },
    ]);
    // groupBy(accountId, type) и отдельный запрос по счёту-получателю.
    txGroupBy
      .mockResolvedValueOnce([{ accountId: "a", type: "TRANSFER", _sum: { amountKop: 20_000_00 } }])
      .mockResolvedValueOnce([{ transferAccountId: "b", _sum: { amountKop: 20_000_00 } }]);

    return accountBalances().then((rows) => {
      expect(rows.find((r) => r.id === "a")?.balanceKop).toBe(80_000_00);
      expect(rows.find((r) => r.id === "b")?.balanceKop).toBe(20_000_00);
      // Перевод не создаёт и не уничтожает деньги.
      expect(rows.reduce((s, r) => s + r.balanceKop, 0)).toBe(100_000_00);
    });
  });

  it("доход прибавляет, расход вычитает, начальный остаток учитывается", async () => {
    accountFindMany.mockResolvedValue([{ id: "a", name: "Карта", openingBalanceKop: 10_000_00 }]);
    txGroupBy
      .mockResolvedValueOnce([
        { accountId: "a", type: "INCOME", _sum: { amountKop: 50_000_00 } },
        { accountId: "a", type: "EXPENSE", _sum: { amountKop: 30_000_00 } },
      ])
      .mockResolvedValueOnce([]);

    const rows = await accountBalances();
    expect(rows[0]?.balanceKop).toBe(30_000_00);
  });

  it("без счетов не ходит в операции", async () => {
    accountFindMany.mockResolvedValue([]);
    expect(await accountBalances()).toEqual([]);
    expect(txGroupBy).not.toHaveBeenCalled();
  });
});

describe("ряд по месяцам", () => {
  it("месяцы идут по возрастанию и режутся по московским суткам", async () => {
    txGroupBy.mockResolvedValue([]);
    const series = await monthlySeries(new Date("2026-07-15T12:00:00Z"), 3);

    expect(series.map((p) => p.key)).toEqual(["2026-05", "2026-06", "2026-07"]);
    expect(series.map((p) => p.label)).toEqual(["май", "июн", "июл"]);
  });

  it("переваливает через границу года", async () => {
    const series = await monthlySeries(new Date("2026-01-15T12:00:00Z"), 3);
    expect(series.map((p) => p.key)).toEqual(["2025-11", "2025-12", "2026-01"]);
  });

  it("прибыль считается как доходы минус расходы", async () => {
    txGroupBy.mockResolvedValue([
      { type: "INCOME", _sum: { amountKop: 100_000_00 }, _count: { _all: 1 } },
      { type: "EXPENSE", _sum: { amountKop: 40_000_00 }, _count: { _all: 2 } },
    ]);
    const series = await monthlySeries(new Date("2026-07-15T12:00:00Z"), 1);
    expect(series[0]?.profitKop).toBe(60_000_00);
  });
});
