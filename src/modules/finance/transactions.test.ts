import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Запись операций: инварианты, из-за нарушения которых итоги перестают
 * сходиться с банком. Сумма всегда положительная (направление задаёт тип),
 * перевод требует второго счёта, ключ дедупа стабилен — иначе повторный
 * импорт выписки удваивает месяц.
 */

const txCreate = vi.fn(async (..._a: unknown[]) => ({ id: "t1" }));

vi.mock("@/core/db", () => ({
  prisma: {
    transaction: { create: (...a: unknown[]) => txCreate(...a) },
  },
}));

const { buildDedupKey, createTransaction, TransactionInputError } = await import("./transactions");

const BASE = {
  type: "EXPENSE" as const,
  amountKop: 350_000,
  date: new Date("2026-07-15T12:00:00Z"),
  accountId: "acc_main",
};

beforeEach(() => {
  txCreate.mockReset();
  txCreate.mockResolvedValue({ id: "t1" });
});

describe("проверка суммы", () => {
  it("отрицательную сумму не принимает", async () => {
    // Знак и тип задавали бы направление вдвоём — однажды они разойдутся.
    await expect(createTransaction({ ...BASE, amountKop: -100 })).rejects.toThrow(
      TransactionInputError,
    );
  });

  it("ноль не принимает", async () => {
    await expect(createTransaction({ ...BASE, amountKop: 0 })).rejects.toThrow();
  });

  it("дробные копейки не принимает", async () => {
    await expect(createTransaction({ ...BASE, amountKop: 100.5 })).rejects.toThrow();
  });

  it("сумму за пределами Int32 отклоняет, а не переполняет молча", async () => {
    await expect(createTransaction({ ...BASE, amountKop: 3_000_000_000 })).rejects.toThrow();
  });
});

describe("перевод", () => {
  it("без счёта-получателя невозможен", async () => {
    await expect(createTransaction({ ...BASE, type: "TRANSFER" })).rejects.toThrow(
      TransactionInputError,
    );
  });

  it("на тот же счёт невозможен", async () => {
    await expect(
      createTransaction({ ...BASE, type: "TRANSFER", transferAccountId: "acc_main" }),
    ).rejects.toThrow();
  });

  it("с другим счётом проходит", async () => {
    await createTransaction({ ...BASE, type: "TRANSFER", transferAccountId: "acc_cash" });
    expect(txCreate).toHaveBeenCalledTimes(1);
  });
});

describe("ключ дедупа", () => {
  const args = {
    accountId: "acc_main",
    date: new Date("2026-07-15T12:00:00Z"),
    amountKop: 350_000,
    description: "АЗС Лукойл",
  };

  it("одинаков для одной и той же строки выписки", () => {
    expect(buildDedupKey(args)).toBe(buildDedupKey({ ...args }));
  });

  it("не зависит от времени внутри суток и от оформления описания", () => {
    // Банк отдаёт то же движение то с временем, то без, то с иным регистром.
    const other = {
      ...args,
      date: new Date("2026-07-15T23:59:00Z"),
      description: "  азс  лукойл!  ",
    };
    expect(buildDedupKey(other)).toBe(buildDedupKey(args));
  });

  it("различается при другой сумме, дате, счёте или описании", () => {
    const key = buildDedupKey(args);
    expect(buildDedupKey({ ...args, amountKop: 350_001 })).not.toBe(key);
    expect(buildDedupKey({ ...args, date: new Date("2026-07-16T12:00:00Z") })).not.toBe(key);
    expect(buildDedupKey({ ...args, accountId: "acc_cash" })).not.toBe(key);
    expect(buildDedupKey({ ...args, description: "АЗС Газпром" })).not.toBe(key);
  });
});

describe("ручной ввод", () => {
  it("не получает ключ дедупа", async () => {
    // Две чашки кофе по 200 ₽ в один день — законная пара операций.
    // Уникальный индекс отверг бы вторую, если бы ключ ставился всегда.
    await createTransaction(BASE);
    const data = (txCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.dedupKey).toBeNull();
    expect(data.source).toBe("MANUAL");
  });
});
