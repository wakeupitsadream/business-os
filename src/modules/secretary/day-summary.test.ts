import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Тесты ночной сводки.
 *
 * Главное свойство — дедуп. Без него «работает из Казани» приезжает в память
 * тридцать раз за месяц, вытесняет из выдачи всё остальное, и поиск начинает
 * возвращать один факт в трёх формулировках. Второе по важности —
 * идемпотентность: повторный прогон после рестарта не должен извлекать те же
 * факты заново.
 */

const llmChatMock = vi.fn();
const saveFactMock = vi.fn(async (..._a: unknown[]) => ({ id: "f1", text: "t", embedded: true }));
const recallMock = vi.fn(async (..._a: unknown[]) => [] as Array<{ via: string }>);
const backfillMock = vi.fn(async (..._a: unknown[]) => ({ done: 0, failed: 0 }));

const journalFindFirst = vi.fn(async (..._a: unknown[]) => null as unknown);
const journalCreate = vi.fn(async (..._a: unknown[]) => ({ id: "j1" }));
const messageFindMany = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const eventFindMany = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const taskFindMany = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const factFindMany = vi.fn(async (..._a: unknown[]) => [] as Array<{ text: string }>);

vi.mock("@/core/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/llm")>();
  return { ...actual, llmChat: (...a: unknown[]) => llmChatMock(...a) };
});

vi.mock("@/core/memory", () => ({
  saveFact: (...a: unknown[]) => saveFactMock(...a),
  recallFacts: (...a: unknown[]) => recallMock(...a),
  backfillEmbeddings: (...a: unknown[]) => backfillMock(...a),
}));

vi.mock("@/core/db", () => ({
  prisma: {
    journalEntry: {
      findFirst: (...a: unknown[]) => journalFindFirst(...a),
      create: (...a: unknown[]) => journalCreate(...a),
    },
    message: { findMany: (...a: unknown[]) => messageFindMany(...a) },
    domainEvent: { findMany: (...a: unknown[]) => eventFindMany(...a) },
    task: { findMany: (...a: unknown[]) => taskFindMany(...a) },
    memoryFact: { findMany: (...a: unknown[]) => factFindMany(...a) },
  },
}));

const { runDaySummary, parseDigest, normalize } = await import("./day-summary");

const NOW = new Date("2026-07-29T19:00:00Z");

function modelReply(payload: unknown) {
  return {
    text: JSON.stringify(payload),
    toolCalls: [],
    rawToolCalls: null,
    gateway: "polza",
    model: "cheap",
    inputTokens: 1,
    outputTokens: 1,
    latencyMs: 1,
  };
}

beforeEach(() => {
  llmChatMock.mockReset();
  saveFactMock.mockReset();
  recallMock.mockReset();
  backfillMock.mockReset();
  journalFindFirst.mockReset();
  journalCreate.mockReset();
  messageFindMany.mockReset();
  eventFindMany.mockReset();
  taskFindMany.mockReset();
  factFindMany.mockReset();

  saveFactMock.mockResolvedValue({ id: "f1", text: "t", embedded: true });
  recallMock.mockResolvedValue([]);
  backfillMock.mockResolvedValue({ done: 0, failed: 0 });
  journalFindFirst.mockResolvedValue(null);
  journalCreate.mockResolvedValue({ id: "j1" });
  messageFindMany.mockResolvedValue([{ role: "USER", content: "осенью перееду в Москву" }]);
  eventFindMany.mockResolvedValue([]);
  taskFindMany.mockResolvedValue([]);
  factFindMany.mockResolvedValue([]);
});

describe("идемпотентность", () => {
  it("повторный прогон не пересказывает день и не извлекает факты заново", async () => {
    journalFindFirst.mockResolvedValue({ id: "j1" });

    const res = await runDaySummary(NOW);

    expect(res.summarized).toBe(false);
    expect(llmChatMock).not.toHaveBeenCalled();
    expect(saveFactMock).not.toHaveBeenCalled();
  });

  it("пустой день не тратит вызов модели", async () => {
    messageFindMany.mockResolvedValue([]);
    eventFindMany.mockResolvedValue([]);

    const res = await runDaySummary(NOW);

    expect(res.summarized).toBe(false);
    expect(llmChatMock).not.toHaveBeenCalled();
    // Но векторы дозаполнить всё равно стоит: это независимая работа.
    expect(backfillMock).toHaveBeenCalled();
  });
});

describe("извлечение фактов", () => {
  it("сохраняет то, что модель не догадалась сохранить в разговоре", async () => {
    llmChatMock.mockResolvedValue(
      modelReply({
        summary: "Обсуждали переезд.",
        facts: [{ text: "Осенью переезжает в Москву", category: "HISTORY" }],
      }),
    );

    const res = await runDaySummary(NOW);

    expect(res.factsAdded).toBe(1);
    expect(saveFactMock).toHaveBeenCalledTimes(1);
    const arg = saveFactMock.mock.calls[0]?.[0] as { text: string; source: string };
    expect(arg.text).toContain("Москву");
    expect(arg.source).toBe("day-summary");
  });

  it("пустой список фактов — нормальный исход, а не ошибка", async () => {
    llmChatMock.mockResolvedValue(modelReply({ summary: "Обычный день.", facts: [] }));

    const res = await runDaySummary(NOW);

    expect(res.summarized).toBe(true);
    expect(res.factsAdded).toBe(0);
    expect(journalCreate).toHaveBeenCalled();
  });

  it("дневник пишется даже когда фактов нет", async () => {
    llmChatMock.mockResolvedValue(modelReply({ summary: "Разбирали задачи.", facts: [] }));
    await runDaySummary(NOW);

    const data = (journalCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.kind).toBe("DAY_SUMMARY");
    expect(data.dayKey).toBe("2026-07-29");
  });
});

describe("дедуп фактов", () => {
  it("близкий по смыслу факт не сохраняется повторно", async () => {
    recallMock.mockResolvedValue([{ via: "vector" }]);
    llmChatMock.mockResolvedValue(
      modelReply({ summary: "…", facts: [{ text: "Работает из Казани", category: "BUSINESS" }] }),
    );

    const res = await runDaySummary(NOW);

    expect(res.factsAdded).toBe(0);
    expect(res.factsSkipped).toBe(1);
    expect(saveFactMock).not.toHaveBeenCalled();
  });

  it("без эмбеддингов дубль ловится по тексту", async () => {
    // Векторный путь молчит (эмбеддингов нет) — остаётся текстовое сравнение.
    recallMock.mockResolvedValue([{ via: "text" }]);
    factFindMany.mockResolvedValue([{ text: "Работает из Казани." }]);
    llmChatMock.mockResolvedValue(
      modelReply({ summary: "…", facts: [{ text: "работает из казани", category: "BUSINESS" }] }),
    );

    const res = await runDaySummary(NOW);

    expect(res.factsSkipped).toBe(1);
    expect(saveFactMock).not.toHaveBeenCalled();
  });

  it("новый факт проходит", async () => {
    recallMock.mockResolvedValue([]);
    factFindMany.mockResolvedValue([{ text: "Работает из Казани" }]);
    llmChatMock.mockResolvedValue(
      modelReply({ summary: "…", facts: [{ text: "Не любит звонки утром", category: "PREFERENCE" }] }),
    );

    const res = await runDaySummary(NOW);
    expect(res.factsAdded).toBe(1);
  });
});

describe("разбор ответа модели", () => {
  it("понимает чистый JSON", () => {
    const d = parseDigest('{"summary":"день","facts":[{"text":"факт","category":"GOAL"}]}');
    expect(d.summary).toBe("день");
    expect(d.facts).toHaveLength(1);
    expect(d.facts[0]?.category).toBe("GOAL");
  });

  it("понимает JSON в markdown-ограде", () => {
    // Модели регулярно оборачивают ответ, даже когда просят этого не делать.
    const d = parseDigest('```json\n{"summary":"день","facts":[]}\n```');
    expect(d.summary).toBe("день");
  });

  it("непонятный ответ не роняет джобу — становится сводкой как есть", () => {
    const d = parseDigest("Сегодня был обычный день без особых событий.");
    expect(d.summary).toContain("обычный день");
    expect(d.facts).toEqual([]);
  });

  it("неизвестная категория заменяется, а не отбрасывает факт", () => {
    const d = parseDigest('{"summary":"s","facts":[{"text":"факт","category":"ВЫДУМАННАЯ"}]}');
    expect(d.facts).toHaveLength(1);
    expect(d.facts[0]?.category).toBe("HISTORY");
  });

  it("мусорные элементы списка пропускаются", () => {
    const d = parseDigest(
      '{"summary":"s","facts":[null,{"text":"Копит на офис","category":"GOAL"},{"nope":1},"строка"]}',
    );
    expect(d.facts).toHaveLength(1);
    expect(d.facts[0]?.text).toBe("Копит на офис");
  });

  it("слишком короткий текст фактом не считается", () => {
    // «ок» и «да» — не факты о владельце, а обрывки. Пропускать их в память
    // значит засорять выдачу мусором, который никогда не пригодится.
    const d = parseDigest('{"summary":"s","facts":[{"text":"ок","category":"GOAL"}]}');
    expect(d.facts).toEqual([]);
  });

  it("количество фактов ограничено", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ text: `факт ${i}`, category: "HISTORY" }));
    const d = parseDigest(JSON.stringify({ summary: "s", facts: many }));
    expect(d.facts.length).toBeLessThanOrEqual(5);
  });
});

describe("нормализация текста для сравнения", () => {
  it("не различает регистр, пунктуацию и ё", () => {
    expect(normalize("Работает из Казани.")).toBe(normalize("работает из казани"));
    expect(normalize("Приём заявок!")).toBe(normalize("прием заявок"));
  });

  it("схлопывает пробелы", () => {
    expect(normalize("  два   пробела  ")).toBe("два пробела");
  });

  it("разные факты остаются разными", () => {
    expect(normalize("работает из Казани")).not.toBe(normalize("работает из Москвы"));
  });
});
