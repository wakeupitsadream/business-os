import { beforeEach, describe, expect, it, vi } from "vitest";
import { markPendingWork, resetPendingWork } from "./pending-work";

/**
 * Гейт кронов лидогена.
 *
 * До него parse-runner и candidate-scoring опрашивали базу 144 раза в сутки
 * при нулевой работе — больше, чем экономила вся оптимизация напоминаний, и
 * именно эти тики ловили просыпающийся Neon и слали владельцу «упала».
 */

const runParseTick = vi.fn(async (..._a: unknown[]) => ({ ok: true, detail: "", idle: true }));
vi.mock("@/modules/sales/leadgen/runner", () => ({
  runParseTick: (...a: unknown[]) => runParseTick(...a),
}));

const scoreCandidates = vi.fn(async (..._a: unknown[]) => ({
  scored: 0,
  skipped: 0,
  reason: "нечего оценивать",
  idle: true,
}));
vi.mock("@/modules/sales/leadgen/scoring", () => ({
  scoreCandidates: (...a: unknown[]) => scoreCandidates(...a),
}));

vi.mock("@/core/db", () => ({
  prisma: { domainEvent: { create: vi.fn(async () => ({})) } },
}));

const { parseRunner, candidateScoring } = await import("./jobs");

beforeEach(() => {
  resetPendingWork();
  runParseTick.mockClear();
  scoreCandidates.mockClear();
  runParseTick.mockResolvedValue({ ok: true, detail: "", idle: true });
  scoreCandidates.mockResolvedValue({ scored: 0, skipped: 0, reason: "нечего оценивать", idle: true });
});

describe("parse-runner", () => {
  it("первый тик после старта идёт в базу, пустой второй — нет", async () => {
    await parseRunner();
    expect(runParseTick).toHaveBeenCalledTimes(1);

    const res = await parseRunner();
    expect(runParseTick).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    expect(res.detail).toContain("не тревожится");
  });

  it("поставленный прогон будит ближайший тик", async () => {
    await parseRunner(); // узнал «пусто»
    markPendingWork("parse");
    await parseRunner();
    expect(runParseTick).toHaveBeenCalledTimes(2);
  });

  it("пока работа есть — тики продолжаются", async () => {
    runParseTick.mockResolvedValue({ ok: true, detail: "страница обработана", idle: false });
    await parseRunner();
    await parseRunner();
    expect(runParseTick).toHaveBeenCalledTimes(2);
  });

  it("ошибка тика не усыпляет курсор: работа могла остаться", async () => {
    runParseTick.mockRejectedValueOnce(new Error("база моргнула"));
    await expect(parseRunner()).rejects.toThrow("моргнула");
    await parseRunner();
    expect(runParseTick).toHaveBeenCalledTimes(2);
  });
});

describe("candidate-scoring", () => {
  it("после «нечего оценивать» спит, пока не появится кандидат", async () => {
    await candidateScoring();
    await candidateScoring();
    expect(scoreCandidates).toHaveBeenCalledTimes(1);

    markPendingWork("scoring");
    await candidateScoring();
    expect(scoreCandidates).toHaveBeenCalledTimes(2);
  });
});
