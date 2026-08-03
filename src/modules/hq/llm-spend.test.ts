import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Расходы на модели.
 *
 * Здесь важнее всего, чтобы проценты складывались во что-то осмысленное и
 * чтобы пустая история не превращалась в деление на ноль: экран расходов
 * открывают в первый раз ровно тогда, когда данных ещё нет.
 */

const aggregate = vi.fn(async (..._a: unknown[]) => ({ _sum: { costKop: 0 } }));
const groupBy = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const findMany = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const queryRaw = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const budgetKop = vi.fn(() => 0);

vi.mock("@/core/llm/usage", () => ({ llmDailyBudgetKop: () => budgetKop() }));

vi.mock("@/core/db", () => ({
  prisma: {
    llmUsage: {
      aggregate: (...a: unknown[]) => aggregate(...a),
      groupBy: (...a: unknown[]) => groupBy(...a),
      findMany: (...a: unknown[]) => findMany(...a),
    },
    $queryRaw: (...a: unknown[]) => queryRaw(...a),
  },
}));

const { loadLlmSpend } = await import("./llm-spend");

const NOW = new Date("2026-08-03T12:00:00Z");

beforeEach(() => {
  aggregate.mockReset().mockResolvedValue({ _sum: { costKop: 0 } });
  groupBy.mockReset().mockResolvedValue([]);
  findMany.mockReset().mockResolvedValue([]);
  queryRaw.mockReset().mockResolvedValue([]);
  budgetKop.mockReset().mockReturnValue(0);
});

describe("пустая история", () => {
  it("не роняет экран и не делит на ноль", async () => {
    const view = await loadLlmSpend(NOW);

    expect(view.todayKop).toBe(0);
    expect(view.monthKop).toBe(0);
    expect(view.byFeature).toEqual([]);
    expect(view.budgetUsed).toBeNull();
  });
});

describe("доля бюджета", () => {
  it("считается только когда лимит задан", async () => {
    budgetKop.mockReturnValue(200_00);
    aggregate.mockResolvedValue({ _sum: { costKop: 100_00 } });

    const view = await loadLlmSpend(NOW);

    expect(view.budgetUsed).toBe(0.5);
  });

  it("без лимита остаётся неизвестной, а не нулём", async () => {
    // Ноль читался бы как «бюджет не тратится», хотя лимита просто нет.
    aggregate.mockResolvedValue({ _sum: { costKop: 100_00 } });

    const view = await loadLlmSpend(NOW);

    expect(view.budgetUsed).toBeNull();
  });
});

describe("разбивка по статьям", () => {
  it("доли считаются от суммы того же периода", async () => {
    // Иначе проценты не сложатся в сто и таблица начнёт врать глазу.
    aggregate.mockResolvedValue({ _sum: { costKop: 1000_00 } });
    groupBy.mockResolvedValue([
      { feature: "sales.scoring", _sum: { costKop: 600_00 }, _count: { _all: 40 } },
      { feature: "secretary.brief", _sum: { costKop: 400_00 }, _count: { _all: 30 } },
    ]);

    const view = await loadLlmSpend(NOW);

    expect(view.byFeature[0]?.share).toBe(0.6);
    expect(view.byFeature[1]?.share).toBe(0.4);
    expect(view.byFeature.reduce((s, f) => s + f.share, 0)).toBeCloseTo(1);
  });

  it("нулевой месячный расход не даёт NaN в долях", async () => {
    groupBy.mockResolvedValue([
      { feature: "memory.embed", _sum: { costKop: 0 }, _count: { _all: 5 } },
    ]);

    const view = await loadLlmSpend(NOW);

    expect(view.byFeature[0]?.share).toBe(0);
    expect(Number.isNaN(view.byFeature[0]?.share ?? NaN)).toBe(false);
  });
});

describe("ряд по дням", () => {
  it("сутки режутся по поясу владельца, а не по UTC", async () => {
    // Иначе вечерний расход уезжал бы в следующий день и ряд расходился бы с
    // дневной цифрой на карточке.
    await loadLlmSpend(NOW);
    const sql = String(queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain("AT TIME ZONE");
  });
});
