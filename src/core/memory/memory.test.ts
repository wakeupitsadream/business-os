import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Тесты памяти на моках.
 *
 * Главное, что здесь проверяется, — деградация. Векторный поиск зависит от
 * возможности провайдера, которой может не быть; память обязана продолжать
 * работать и никогда не ронять ответ владельцу.
 */

const embedMock = vi.fn();
const factCreate = vi.fn(async (..._a: unknown[]) => ({ id: "f1", text: "текст" }));
const factFindMany = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const executeRaw = vi.fn(async (..._a: unknown[]) => 1);
const queryRaw = vi.fn(async (..._a: unknown[]) => [] as unknown[]);

vi.mock("@/core/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/llm")>();
  return { ...actual, llmEmbed: (...a: unknown[]) => embedMock(...a) };
});

vi.mock("@/core/db", () => ({
  prisma: {
    memoryFact: {
      create: (...a: unknown[]) => factCreate(...a),
      findMany: (...a: unknown[]) => factFindMany(...a),
    },
    $executeRaw: (...a: unknown[]) => executeRaw(...a),
    $queryRaw: (...a: unknown[]) => queryRaw(...a),
  },
}));

const { saveFact, toVectorLiteral } = await import("./facts");
const { recallFacts, formatFactsForPrompt } = await import("./search");

const VECTOR = Array.from({ length: 1536 }, () => 0.01);

beforeEach(() => {
  embedMock.mockReset();
  factCreate.mockReset();
  factFindMany.mockReset();
  executeRaw.mockReset();
  queryRaw.mockReset();

  factCreate.mockResolvedValue({ id: "f1", text: "текст" });
  factFindMany.mockResolvedValue([]);
  executeRaw.mockResolvedValue(1);
  queryRaw.mockResolvedValue([]);
});

describe("сохранение факта", () => {
  it("считает вектор и записывает его", async () => {
    embedMock.mockResolvedValue([VECTOR]);
    const saved = await saveFact({ text: "Не любит звонки до полудня" });

    expect(saved.embedded).toBe(true);
    expect(factCreate).toHaveBeenCalledTimes(1);
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it("сохраняет факт, даже если эмбеддинги недоступны", async () => {
    // Потерять текст хуже, чем остаться без вектора: без вектора факт всё ещё
    // находится по словам, без текста не существует вовсе.
    embedMock.mockRejectedValue(new Error("провайдер не умеет эмбеддинги"));

    const saved = await saveFact({ text: "Работает из Казани" });

    expect(saved.id).toBe("f1");
    expect(saved.embedded).toBe(false);
    expect(factCreate).toHaveBeenCalledTimes(1);
  });

  it("вектор неверной длины не записывается", async () => {
    // Колонка объявлена как vector(1536); запись другой длины упала бы уже
    // в модуле памяти, а всплыла бы непонятной ошибкой у владельца.
    embedMock.mockResolvedValue([[0.1, 0.2, 0.3]]);

    const saved = await saveFact({ text: "факт" });

    expect(saved.embedded).toBe(false);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("пустой факт отклоняется", async () => {
    await expect(saveFact({ text: "   " })).rejects.toThrow();
    expect(factCreate).not.toHaveBeenCalled();
  });

  it("важность зажимается в допустимый диапазон", async () => {
    embedMock.mockResolvedValue([VECTOR]);
    await saveFact({ text: "факт", importance: 99 });

    const data = (factCreate.mock.calls[0]?.[0] as { data: { importance: number } }).data;
    expect(data.importance).toBe(3);
  });
});

describe("поиск фактов", () => {
  it("закреплённые факты попадают в контекст независимо от запроса", async () => {
    factFindMany.mockResolvedValue([
      { id: "p1", text: "Цель — 300 тысяч в месяц", category: "GOAL", importance: 3, pinned: true },
    ]);
    embedMock.mockRejectedValue(new Error("нет эмбеддингов"));

    const facts = await recallFacts("что угодно");

    expect(facts.some((f) => f.id === "p1" && f.via === "always")).toBe(true);
  });

  it("при недоступных эмбеддингах уходит в поиск по словам", async () => {
    embedMock.mockRejectedValue(new Error("нет эмбеддингов"));
    queryRaw.mockResolvedValue([
      { id: "t1", text: "Работает из Казани", category: "BUSINESS", importance: 2, pinned: false },
    ]);

    const facts = await recallFacts("Казань");

    expect(facts.map((f) => f.via)).toContain("text");
    expect(queryRaw).toHaveBeenCalled();
  });

  it("использует вектор, когда он доступен", async () => {
    embedMock.mockResolvedValue([VECTOR]);
    queryRaw.mockResolvedValue([
      {
        id: "v1",
        text: "Плохо спит после полуночи",
        category: "HEALTH",
        importance: 2,
        pinned: false,
        distance: 0.2,
      },
    ]);

    const facts = await recallFacts("сон");

    expect(facts.some((f) => f.via === "vector")).toBe(true);
  });

  it("далёкие по смыслу совпадения отбрасываются", async () => {
    // Уверенно вспомнить не то хуже, чем не вспомнить ничего.
    embedMock.mockResolvedValue([VECTOR]);
    queryRaw.mockResolvedValue([
      { id: "far", text: "случайное", category: "HISTORY", importance: 1, pinned: false, distance: 0.95 },
    ]);

    const facts = await recallFacts("выручка");

    expect(facts.some((f) => f.id === "far")).toBe(false);
  });

  it("пустой запрос отдаёт только всегда-актуальное, не трогая модель", async () => {
    factFindMany.mockResolvedValue([
      { id: "p1", text: "закреплено", category: "GOAL", importance: 3, pinned: true },
    ]);

    const facts = await recallFacts("   ");

    expect(facts).toHaveLength(1);
    expect(embedMock).not.toHaveBeenCalled();
  });

  it("не дублирует факт, найденный и как закреплённый, и по запросу", async () => {
    factFindMany.mockResolvedValue([
      { id: "same", text: "цель", category: "GOAL", importance: 3, pinned: true },
    ]);
    embedMock.mockRejectedValue(new Error("нет"));
    queryRaw.mockResolvedValue([
      { id: "same", text: "цель", category: "GOAL", importance: 3, pinned: true },
    ]);

    const facts = await recallFacts("цель");

    expect(facts.filter((f) => f.id === "same")).toHaveLength(1);
  });

  it("сбой поиска по словам не роняет вызов", async () => {
    embedMock.mockRejectedValue(new Error("нет эмбеддингов"));
    queryRaw.mockRejectedValue(new Error("база недоступна"));

    await expect(recallFacts("что-нибудь")).resolves.toEqual([]);
  });
});

describe("toVectorLiteral", () => {
  it("формирует литерал pgvector", () => {
    expect(toVectorLiteral([0.1, 0.2, 0.3])).toBe("[0.1,0.2,0.3]");
  });

  it("нечисловые значения не попадают в запрос", () => {
    // NaN в векторе роняет вставку сообщением, по которому причину не найти.
    expect(toVectorLiteral([1, Number.NaN, Number.POSITIVE_INFINITY])).toBe("[1,0,0]");
  });
});

describe("formatFactsForPrompt", () => {
  it("без фактов не добавляет пустой блок в промпт", () => {
    expect(formatFactsForPrompt([])).toBe("");
  });

  it("перечисляет факты списком", () => {
    const block = formatFactsForPrompt([
      { id: "1", text: "Работает из Казани", category: "BUSINESS", importance: 2, pinned: false, via: "text" },
    ]);
    expect(block).toContain("Работает из Казани");
    expect(block).toContain("помню");
  });
});
