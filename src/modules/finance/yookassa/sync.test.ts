import { beforeEach, describe, expect, it, vi } from "vitest";
import { yooAmountToKop } from "./types";

/**
 * Синк ЮKassa. Это единственный источник выручки на старте, поэтому здесь
 * проверяются два свойства: не потерять платёж и не посчитать его дважды.
 *
 * И отдельно — арифметика комиссии. В `PLAN.md` было написано брать доходом
 * `income_amount`, но он уже за вычетом комиссии: парная операция вычла бы её
 * второй раз, и прибыль оказалась бы занижена ровно на комиссию — незаметно,
 * потому что все числа выглядят правдоподобно.
 */

const txFindFirst = vi.fn(async (..._a: unknown[]) => null as unknown);
const txCreate = vi.fn(async (..._a: unknown[]) => ({ id: "t1" }));
const accountFindUnique = vi.fn(async (..._a: unknown[]) => null as unknown);
const accountUpdate = vi.fn(async (..._a: unknown[]) => ({}));
const categoryFindMany = vi.fn(async (..._a: unknown[]) => [] as unknown[]);

vi.mock("@/core/db", () => ({
  prisma: {
    transaction: {
      findFirst: (...a: unknown[]) => txFindFirst(...a),
      create: (...a: unknown[]) => txCreate(...a),
    },
    account: {
      findUnique: (...a: unknown[]) => accountFindUnique(...a),
      update: (...a: unknown[]) => accountUpdate(...a),
    },
    category: { findMany: (...a: unknown[]) => categoryFindMany(...a) },
  },
}));

const fetchPayments = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const configured = vi.fn(() => true);

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return {
    ...actual,
    yooConfigured: () => configured(),
    fetchSucceededPayments: (...a: unknown[]) => fetchPayments(...a),
  };
});

const { syncYooKassa, writePayment, YOOKASSA_ACCOUNT_ID } = await import("./sync");

const NOW = new Date("2026-07-30T12:00:00Z");

function payment(over: Record<string, unknown> = {}) {
  return {
    id: "2f0a1b2c-000f-5000-9000-1a2b3c4d5e6f",
    status: "succeeded",
    amount: { value: "10000.00", currency: "RUB" },
    income_amount: { value: "9650.00", currency: "RUB" },
    description: "Оплата подписки Agentus",
    created_at: "2026-07-29T10:00:00.000Z",
    captured_at: "2026-07-29T10:00:05.000Z",
    ...over,
  };
}

const created = () =>
  txCreate.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);

beforeEach(() => {
  txFindFirst.mockReset();
  txCreate.mockReset();
  accountFindUnique.mockReset();
  accountUpdate.mockReset();
  categoryFindMany.mockReset();
  fetchPayments.mockReset();
  configured.mockReset();

  txFindFirst.mockResolvedValue(null);
  txCreate.mockResolvedValue({ id: "t1" });
  accountFindUnique.mockResolvedValue({ id: YOOKASSA_ACCOUNT_ID, lastSyncedAt: null });
  accountUpdate.mockResolvedValue({});
  categoryFindMany.mockResolvedValue([]);
  fetchPayments.mockResolvedValue([]);
  configured.mockReturnValue(true);
});

describe("разбор суммы", () => {
  it("копейки не теряются на дробях", () => {
    // Number("1500.10") * 100 = 150009.99999999999 — округление вниз съело бы
    // копейку на каждом платеже.
    expect(yooAmountToKop("1500.10")).toBe(150_010);
    expect(yooAmountToKop("0.01")).toBe(1);
    expect(yooAmountToKop("10000.00")).toBe(1_000_000);
  });

  it("понимает суммы без дробной части и с запятой", () => {
    expect(yooAmountToKop("500")).toBe(50_000);
    expect(yooAmountToKop("500,5")).toBe(50_050);
  });

  it("мусор суммой не становится", () => {
    expect(yooAmountToKop("много")).toBeNull();
    expect(yooAmountToKop("")).toBeNull();
    expect(yooAmountToKop("1.234")).toBeNull();
  });
});

describe("проводка платежа", () => {
  const ctx = { sets: [], feeSets: [] };

  it("доход равен тому, что заплатил клиент, а не тому, что дошло", async () => {
    await writePayment(payment(), ctx);

    const rows = created();
    const income = rows.find((r) => r.type === "INCOME");
    expect(income?.amountKop).toBe(1_000_000); // 10 000 ₽ — сумма клиента
  });

  it("комиссия записывается отдельной операцией", async () => {
    await writePayment(payment(), ctx);

    const fee = created().find((r) => r.type === "EXPENSE");
    expect(fee?.amountKop).toBe(35_000); // 10 000 − 9 650 = 350 ₽
    expect(fee?.externalId).toBe("2f0a1b2c-000f-5000-9000-1a2b3c4d5e6f:fee");
  });

  it("доход минус комиссия равен тому, что дошло до магазина", async () => {
    // Ровно та арифметика, которую ломала формулировка в PLAN.md.
    await writePayment(payment(), ctx);

    const rows = created();
    const income = rows.find((r) => r.type === "INCOME")?.amountKop as number;
    const fee = rows.find((r) => r.type === "EXPENSE")?.amountKop as number;
    expect(income - fee).toBe(965_000);
  });

  it("без income_amount комиссии нет, а доход всё равно записан", async () => {
    await writePayment(payment({ income_amount: undefined }), ctx);

    const rows = created();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("INCOME");
    expect(rows[0]?.amountKop).toBe(1_000_000);
  });

  it("нулевая комиссия отдельной операции не создаёт", async () => {
    await writePayment(payment({ income_amount: { value: "10000.00", currency: "RUB" } }), ctx);
    expect(created().filter((r) => r.type === "EXPENSE")).toHaveLength(0);
  });

  it("платёж в чужой валюте пропускается, а не записывается как рубли", async () => {
    const res = await writePayment(
      payment({ amount: { value: "100.00", currency: "USD" } }),
      ctx,
    );
    expect(res).toEqual({ income: 0, fee: 0 });
    expect(txCreate).not.toHaveBeenCalled();
  });

  it("дата операции — момент подтверждения, а не создания", async () => {
    await writePayment(payment(), ctx);
    const income = created().find((r) => r.type === "INCOME");
    expect((income?.date as Date).toISOString()).toBe("2026-07-29T10:00:05.000Z");
  });

  it("уже записанный платёж второй раз не пишется", async () => {
    txFindFirst.mockResolvedValue({ id: "existing" });
    const res = await writePayment(payment(), ctx);

    expect(res).toEqual({ income: 0, fee: 0 });
    expect(txCreate).not.toHaveBeenCalled();
  });

  it("идентификатор платежа сохраняется для дедупа", async () => {
    await writePayment(payment(), ctx);
    const income = created().find((r) => r.type === "INCOME");
    expect(income?.externalId).toBe("2f0a1b2c-000f-5000-9000-1a2b3c4d5e6f");
    expect(income?.source).toBe("YOOKASSA");
  });
});

describe("прогон синка", () => {
  it("без ключей отвечает «не настроено», а не ошибкой", async () => {
    // Ненастроенная интеграция не должна выглядеть как поломка системы.
    configured.mockReturnValue(false);
    const res = await syncYooKassa(NOW);

    expect(res.configured).toBe(false);
    expect(fetchPayments).not.toHaveBeenCalled();
  });

  it("первый прогон берёт большое окно, следующие — от курсора с перекрытием", async () => {
    await syncYooKassa(NOW);
    const cold = (fetchPayments.mock.calls[0]?.[0] as { since: Date }).since;
    expect(NOW.getTime() - cold.getTime()).toBeGreaterThan(80 * 24 * 3600 * 1000);

    fetchPayments.mockClear();
    accountFindUnique.mockResolvedValue({
      id: YOOKASSA_ACCOUNT_ID,
      lastSyncedAt: new Date("2026-07-30T06:00:00Z"),
    });

    await syncYooKassa(NOW);
    const warm = (fetchPayments.mock.calls[0]?.[0] as { since: Date }).since;
    // Перекрытие 48 часов — страховка от расхождения часов и гонок на границе
    // окна. От позднего подтверждения защищает не оно, а фильтр по captured_at
    // (см. client.ts): раньше комментарий здесь утверждал обратное, и это
    // неверное объяснение прятало потерю на несколько месяцев.
    expect(warm.toISOString()).toBe("2026-07-28T06:00:00.000Z");
  });

  it("контрольный прогон углубляет окно до тридцати дней", async () => {
    accountFindUnique.mockResolvedValue({
      id: YOOKASSA_ACCOUNT_ID,
      lastSyncedAt: new Date("2026-07-30T06:00:00Z"),
    });

    await syncYooKassa(NOW, { minLookbackMs: 30 * 24 * 3600 * 1000 });

    const since = (fetchPayments.mock.calls[0]?.[0] as { since: Date }).since;
    expect(NOW.getTime() - since.getTime()).toBe(30 * 24 * 3600 * 1000);
  });

  it("контрольный прогон не сужает холодное окно", async () => {
    // При холодном старте штатные 90 дней шире контрольных 30 — брать минимум
    // из двух границ, а не подменять, иначе страховка обрежет первый прогон.
    await syncYooKassa(NOW, { minLookbackMs: 30 * 24 * 3600 * 1000 });

    const since = (fetchPayments.mock.calls[0]?.[0] as { since: Date }).since;
    expect(NOW.getTime() - since.getTime()).toBeGreaterThan(80 * 24 * 3600 * 1000);
  });

  it("курсор двигается только после записи всех платежей", async () => {
    fetchPayments.mockResolvedValue([payment()]);
    await syncYooKassa(NOW);

    expect(accountUpdate).toHaveBeenCalledTimes(1);
    const data = (accountUpdate.mock.calls[0]?.[0] as { data: { lastSyncedAt: Date } }).data;
    expect(data.lastSyncedAt).toBe(NOW);
  });

  it("падение записи не двигает курсор", async () => {
    // Иначе при сбое на середине хвост платежей теряется навсегда.
    fetchPayments.mockResolvedValue([payment()]);
    txCreate.mockRejectedValue(new Error("база недоступна"));

    await expect(syncYooKassa(NOW)).rejects.toThrow();
    expect(accountUpdate).not.toHaveBeenCalled();
  });

  it("повторный прогон на тех же платежах не создаёт операций", async () => {
    fetchPayments.mockResolvedValue([payment(), payment({ id: "second" })]);
    txFindFirst.mockResolvedValue({ id: "existing" });

    const res = await syncYooKassa(NOW);

    expect(res.createdIncome).toBe(0);
    expect(res.createdFees).toBe(0);
    expect(res.skippedExisting).toBe(2);
    expect(txCreate).not.toHaveBeenCalled();
  });

  it("считает поступления и комиссии раздельно", async () => {
    fetchPayments.mockResolvedValue([payment(), payment({ id: "second" })]);
    const res = await syncYooKassa(NOW);

    expect(res.fetched).toBe(2);
    expect(res.createdIncome).toBe(2);
    expect(res.createdFees).toBe(2);
  });
});
