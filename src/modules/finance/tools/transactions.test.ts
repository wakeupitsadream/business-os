import { beforeEach, describe, expect, it, vi } from "vitest";
import { isDangerous } from "@/core/orchestrator";
import { THOUSANDS_SEPARATOR } from "@/core/shared/money";

/**
 * Инструменты финансов глазами модели.
 *
 * Проверяется то, из-за чего учёт молча портится: разряд суммы («3 тыс» против
 * «300 тысяч»), подстановка счёта по умолчанию и запрет считать деньги самой
 * моделью — суммы обязаны приходить из агрегата базы.
 */

const categoryFindFirst = vi.fn(async (..._a: unknown[]) => null as unknown);
const accountFindFirst = vi.fn(async (..._a: unknown[]) => null as unknown);
const projectFindFirst = vi.fn(async (..._a: unknown[]) => null as unknown);
const categoryFindMany = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const txCreate = vi.fn(async (..._a: unknown[]) => ({ id: "t1" }));
const txGroupBy = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const txFindMany = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const llmChatMock = vi.fn();

vi.mock("@/core/db", () => ({
  prisma: {
    category: {
      findFirst: (...a: unknown[]) => categoryFindFirst(...a),
      findMany: (...a: unknown[]) => categoryFindMany(...a),
    },
    account: { findFirst: (...a: unknown[]) => accountFindFirst(...a) },
    project: { findFirst: (...a: unknown[]) => projectFindFirst(...a) },
    transaction: {
      create: (...a: unknown[]) => txCreate(...a),
      groupBy: (...a: unknown[]) => txGroupBy(...a),
      findMany: (...a: unknown[]) => txFindMany(...a),
    },
  },
}));

vi.mock("@/core/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/llm")>();
  return { ...actual, llmChat: (...a: unknown[]) => llmChatMock(...a) };
});

const { addTransaction, queryFinance } = await import("./transactions");

const CTX = { runId: "run1", channel: "TELEGRAM" as const, now: new Date("2026-07-15T12:00:00Z") };

const CATEGORIES = [
  { id: "cat_transport", name: "Транспорт", type: "EXPENSE", aliases: ["бензин", "такси"], parentId: "cat_ops" },
  { id: "cat_ads", name: "Реклама", type: "EXPENSE", aliases: ["реклама", "таргет"], parentId: "cat_marketing" },
];

beforeEach(() => {
  categoryFindFirst.mockReset();
  accountFindFirst.mockReset();
  projectFindFirst.mockReset();
  categoryFindMany.mockReset();
  txCreate.mockReset();
  txGroupBy.mockReset();
  txFindMany.mockReset();
  llmChatMock.mockReset();

  categoryFindFirst.mockResolvedValue(null);
  accountFindFirst.mockResolvedValue({ id: "acc_main", name: "Основная карта" });
  projectFindFirst.mockResolvedValue(null);
  categoryFindMany.mockResolvedValue(CATEGORIES);
  txCreate.mockResolvedValue({ id: "t1" });
  txGroupBy.mockResolvedValue([]);
  txFindMany.mockResolvedValue([]);
});

function created(): Record<string, unknown> {
  return (txCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
}

describe("add_transaction", () => {
  it("«потратил 3500 на бензин» создаёт расход с верной категорией", async () => {
    const res = await addTransaction.execute(
      { direction: "expense", amount: "3500", description: "бензин" },
      CTX,
    );

    expect(res.ok).toBe(true);
    const data = created();
    expect(data.amountKop).toBe(350_000);
    expect(data.type).toBe("EXPENSE");
    expect(data.categoryId).toBe("cat_transport");
    expect(data.accountId).toBe("acc_main");
    // Канал определяет источник: по нему потом видно, откуда пришёл учёт.
    expect(data.source).toBe("TELEGRAM");
    expect(llmChatMock).not.toHaveBeenCalled();
  });

  it("разговорные формы суммы понимает без модели", async () => {
    await addTransaction.execute(
      { direction: "expense", amount: "12к", description: "реклама в директе" },
      CTX,
    );
    expect(created().amountKop).toBe(1_200_000);
  });

  it("доход записывается как доход", async () => {
    await addTransaction.execute(
      { direction: "income", amount: "40 тыс", description: "оплата от клиента" },
      CTX,
    );
    expect(created().type).toBe("INCOME");
    expect(created().amountKop).toBe(4_000_000);
  });

  it("непонятная сумма не создаёт операцию", async () => {
    const res = await addTransaction.execute(
      { direction: "expense", amount: "сколько-то", description: "бензин" },
      CTX,
    );
    expect(res.ok).toBe(false);
    expect(txCreate).not.toHaveBeenCalled();
  });

  it("без единого счёта честно отказывается", async () => {
    accountFindFirst.mockResolvedValue(null);
    const res = await addTransaction.execute(
      { direction: "expense", amount: "500", description: "кофе" },
      CTX,
    );
    expect(res.ok).toBe(false);
    expect(txCreate).not.toHaveBeenCalled();
  });

  it("категория не подобралась — операция всё равно записывается", async () => {
    // Сумма и дата важнее категории: потерять расход хуже, чем не назвать его.
    categoryFindMany.mockResolvedValue([]);
    const res = await addTransaction.execute(
      { direction: "expense", amount: "1500", description: "подарок жене" },
      CTX,
    );
    expect(res.ok).toBe(true);
    expect(created().categoryId).toBeNull();
    expect(res.message).toContain("БЕЗ категории");
  });

  it("выдуманное моделью название категории в базу не попадает", async () => {
    llmChatMock.mockResolvedValue({
      text: "Прочие расходы",
      toolCalls: [],
      rawToolCalls: null,
      gateway: "polza",
      model: "cheap",
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
    });

    await addTransaction.execute(
      { direction: "expense", amount: "1500", description: "что-то неопознанное" },
      CTX,
    );
    expect(created().categoryId).toBeNull();
  });
});

describe("порог подтверждения", () => {
  it("обычный расход подтверждения не требует", () => {
    expect(isDangerous(addTransaction, { direction: "expense", amount: "3500", description: "бензин" })).toBe(false);
  });

  it("сумма от 50 000 ₽ уходит на подтверждение владельцу", () => {
    expect(isDangerous(addTransaction, { direction: "expense", amount: "50000", description: "подряд" })).toBe(true);
    expect(isDangerous(addTransaction, { direction: "expense", amount: "300 тыс", description: "оборудование" })).toBe(true);
  });

  it("ошибка модели в разряде ловится порогом", () => {
    // «3 тыс» превратились в «300 тысяч» — ровно тот случай, ради которого
    // порог и заведён.
    expect(isDangerous(addTransaction, { direction: "expense", amount: "3 тыс", description: "реклама" })).toBe(false);
    expect(isDangerous(addTransaction, { direction: "expense", amount: "300 тыс", description: "реклама" })).toBe(true);
  });

  it("неразбираемая сумма опасной не считается — её отвергнет сам инструмент", () => {
    expect(isDangerous(addTransaction, { direction: "expense", amount: "много", description: "x" })).toBe(false);
  });
});

describe("query_finance", () => {
  it("сумму берёт из агрегата базы, а не из списка операций", async () => {
    txGroupBy.mockResolvedValue([
      { type: "EXPENSE", _sum: { amountKop: 1_234_500 }, _count: { _all: 3 } },
    ]);
    categoryFindFirst.mockResolvedValue({ id: "cat_ads", name: "Реклама" });
    categoryFindMany.mockResolvedValue([]); // подкатегорий у «Рекламы» нет

    const res = await queryFinance.execute({ period: "month", category: "реклама" }, CTX);

    expect(res.ok).toBe(true);
    // Разделитель разрядов — неразрывный пробел; записан escape-последовательностью,
    // иначе расхождение видно только по непонятному «expected '…' to be '…'».
    expect(res.message).toContain(`12${THOUSANDS_SEPARATOR}345${THOUSANDS_SEPARATOR}₽`);
    expect(res.data?.amountKop).toBe(1_234_500);
    expect(txFindMany).not.toHaveBeenCalled();
  });

  it("родительская категория включает подкатегории", async () => {
    // Иначе «сколько ушло на маркетинг» отвечает нулём, и ноль выглядит правдой.
    categoryFindFirst.mockResolvedValue({ id: "cat_marketing", name: "Маркетинг" });
    categoryFindMany.mockResolvedValue([{ id: "cat_ads" }, { id: "cat_content" }]);
    txGroupBy.mockResolvedValue([
      { type: "EXPENSE", _sum: { amountKop: 500_000 }, _count: { _all: 2 } },
    ]);

    await queryFinance.execute({ period: "month", category: "Маркетинг" }, CTX);

    const where = (txGroupBy.mock.calls[0]?.[0] as { where: { categoryId?: { in: string[] } } }).where;
    expect(where.categoryId?.in).toEqual(["cat_marketing", "cat_ads", "cat_content"]);
  });

  it("пустой период отвечает «операций нет», а не нулём в отчёте", async () => {
    categoryFindFirst.mockResolvedValue({ id: "cat_ads", name: "Реклама" });
    categoryFindMany.mockResolvedValue([]);
    txGroupBy.mockResolvedValue([]);

    const res = await queryFinance.execute({ period: "prev_month", category: "реклама" }, CTX);
    expect(res.message).toContain("операций нет");
  });

  it("несуществующую категорию не выдаёт за пустой период", async () => {
    categoryFindFirst.mockResolvedValue(null);
    categoryFindMany.mockResolvedValue(CATEGORIES);

    const res = await queryFinance.execute({ period: "month", category: "криптовалюта" }, CTX);
    expect(res.ok).toBe(false);
    expect(txGroupBy).not.toHaveBeenCalled();
  });

  it("итоги считают прибыль как доходы минус расходы", async () => {
    txGroupBy
      .mockResolvedValueOnce([
        { type: "INCOME", _sum: { amountKop: 10_000_00 }, _count: { _all: 2 } },
        { type: "EXPENSE", _sum: { amountKop: 4_000_00 }, _count: { _all: 5 } },
      ])
      .mockResolvedValueOnce([]);

    const res = await queryFinance.execute({ period: "month" }, CTX);
    expect(res.data?.profitKop).toBe(600_000);
  });
});
