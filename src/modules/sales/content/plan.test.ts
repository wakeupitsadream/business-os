import { beforeEach, describe, expect, it, vi } from "vitest";
import { TZDate } from "@date-fns/tz";
import { OWNER_TZ } from "@/core/shared/time";

/**
 * Недельный план контента.
 *
 * Граница та же, что у брифа: код считает даты и рубрики, модель придумывает
 * только темы. Тесты стерегут именно эту границу — и то, что план получается
 * даже без модели.
 */

const llmChatMock = vi.fn();
const postCount = vi.fn(async (..._a: unknown[]) => 0);
const postFindMany = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const postCreate = vi.fn(async (..._a: unknown[]) => ({ id: "p1" }));

vi.mock("@/core/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/llm")>();
  return { ...actual, llmChat: (...a: unknown[]) => llmChatMock(...a) };
});

vi.mock("@/core/db", () => ({
  prisma: {
    contentPost: {
      count: (...a: unknown[]) => postCount(...a),
      findMany: (...a: unknown[]) => postFindMany(...a),
      create: (...a: unknown[]) => postCreate(...a),
    },
  },
}));

const { balanceRubrics, buildWeeklyPlan, looksRepeated, parseIdeas, planSlots } = await import(
  "./plan"
);
const { LlmUnavailableError } = await import("@/core/llm");

// Понедельник 3 августа 2026, утро по времени владельца.
const NOW = new Date("2026-08-03T06:00:00Z");

function ideasJson(n: number) {
  return JSON.stringify(
    Array.from({ length: n }, (_, i) => ({
      slotId: i + 1,
      title: `Тема номер ${i + 1} про что-то полезное`,
      reasoning: "потому что",
    })),
  );
}

beforeEach(() => {
  llmChatMock.mockReset();
  postCount.mockReset().mockResolvedValue(0);
  postFindMany.mockReset().mockResolvedValue([]);
  postCreate.mockReset().mockResolvedValue({ id: "p1" });
  llmChatMock.mockResolvedValue({
    text: ideasJson(4),
    toolCalls: [],
    rawToolCalls: null,
    gateway: "polza",
    model: "m",
    inputTokens: 1,
    outputTokens: 1,
    latencyMs: 1,
  });
});

describe("слоты считает код", () => {
  it("четыре слота через день от понедельника", () => {
    const slots = planSlots(NOW);
    expect(slots).toHaveLength(4);

    const days = slots.map((s) => new TZDate(s.scheduledAt, OWNER_TZ).getDate());
    expect(days).toEqual([3, 5, 7, 9]); // Пн, Ср, Пт, Вс
  });

  it("часы публикации — по времени владельца, а не UTC", () => {
    const hours = planSlots(NOW).map((s) => new TZDate(s.scheduledAt, OWNER_TZ).getHours());
    expect(hours).toEqual([10, 19, 10, 19]);
  });

  it("воскресный вечер попадает в свою неделю, а не в следующую", () => {
    // Воскресенье 2 августа 23:00 по владельцу = 18:00 UTC.
    const sundayEvening = new Date("2026-08-02T18:00:00Z");
    const slots = planSlots(sundayEvening);
    const firstDay = new TZDate(slots[0]!.scheduledAt, OWNER_TZ).getDate();
    expect(firstDay).toBe(27); // понедельник ПРОШЛОЙ недели, 27 июля
  });
});

describe("баланс рубрик держит код", () => {
  it("недобранные рубрики идут первыми", () => {
    const slots = planSlots(NOW);
    // Последние посты были сплошь кейсами — значит кейс уходит в конец.
    const balanced = balanceRubrics(slots, ["CASE", "CASE", "CASE", "CASE"]);
    expect(balanced[0]?.rubric).not.toBe("CASE");
  });

  it("на пустой истории рубрики всё равно разные", () => {
    const balanced = balanceRubrics(planSlots(NOW), []);
    expect(new Set(balanced.map((s) => s.rubric)).size).toBe(4);
  });
});

describe("ответ модели не принимается на веру", () => {
  it("выдуманный слот отбрасывается", () => {
    // Модель, получившая четыре слота, охотно возвращает пятый.
    const raw = JSON.stringify([
      { slotId: 1, title: "Нормальная тема про клиентов", reasoning: "" },
      { slotId: 99, title: "Тема в слот, которого нет", reasoning: "" },
    ]);
    const ideas = parseIdeas(raw, new Set([1, 2, 3, 4]));
    expect(ideas.map((i) => i.slotId)).toEqual([1]);
  });

  it("повтор одного слота дважды берётся один раз", () => {
    const raw = JSON.stringify([
      { slotId: 2, title: "Первая версия темы про заявки", reasoning: "" },
      { slotId: 2, title: "Вторая версия темы про заявки", reasoning: "" },
    ]);
    expect(parseIdeas(raw, new Set([1, 2]))).toHaveLength(1);
  });

  it("обрывок вместо заголовка отбрасывается", () => {
    const raw = JSON.stringify([{ slotId: 1, title: "Кейс", reasoning: "" }]);
    expect(parseIdeas(raw, new Set([1]))).toHaveLength(0);
  });

  it("не-JSON не роняет разбор", () => {
    expect(parseIdeas("извините, не могу", new Set([1]))).toEqual([]);
  });
});

describe("антиповтор вторым, кодовым уровнем", () => {
  it("та же мысль другими словами считается повтором", () => {
    // Инструкцию «не повторяйся» модели выполняют ненадёжно.
    const recent = ["Как автосервис перестал терять заявки"];
    expect(looksRepeated("Автосервис больше не теряет заявки клиентов", recent)).toBe(true);
  });

  it("другая тема повтором не считается", () => {
    const recent = ["Как автосервис перестал терять заявки"];
    expect(looksRepeated("Сколько стоит запустить рекламу в Директе", recent)).toBe(false);
  });

  it("пустая история никого не блокирует", () => {
    expect(looksRepeated("Любая тема", [])).toBe(false);
  });
});

describe("план собирается", () => {
  it("за один клик появляются четыре идеи", async () => {
    const res = await buildWeeklyPlan(NOW);

    expect(res.created).toBe(4);
    expect(res.degraded).toBe(false);
    expect(res.planKey).toBe("2026-W32");
    expect(postCreate).toHaveBeenCalledTimes(4);
  });

  it("второй клик ничего не создаёт", async () => {
    postCount.mockResolvedValue(4);

    const res = await buildWeeklyPlan(NOW);

    expect(res.existed).toBe(true);
    expect(res.created).toBe(0);
    expect(postCreate).not.toHaveBeenCalled();
    expect(llmChatMock).not.toHaveBeenCalled();
  });

  it("без модели план всё равно получается — и честно помечен", async () => {
    // Слоты, даты и рубрики считает код, поэтому отказ кнопки здесь ни от чего
    // не защищает. Но владелец обязан видеть, что модели не было.
    llmChatMock.mockRejectedValue(new LlmUnavailableError("шлюзы недоступны"));

    const res = await buildWeeklyPlan(NOW);

    expect(res.created).toBe(4);
    expect(res.degraded).toBe(true);
    const created = postCreate.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
    expect(created.every((d) => d.degraded === true)).toBe(true);
    expect(created.every((d) => typeof d.title === "string" && (d.title as string).length > 0)).toBe(true);
  });

  it("даты в записях ставит код, а не модель", async () => {
    await buildWeeklyPlan(NOW);
    const created = postCreate.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
    expect(created.every((d) => d.scheduledAt instanceof Date)).toBe(true);
    expect(created.every((d) => d.planKey === "2026-W32")).toBe(true);
  });

  it("тема, похожая на недавнюю, заменяется заготовкой", async () => {
    postFindMany.mockResolvedValue([
      { title: "Тема номер 1 про что-то полезное", rubric: "CASE" },
    ]);

    await buildWeeklyPlan(NOW);

    const created = postCreate.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
    const replaced = created.filter((d) => d.degraded === true);
    expect(replaced.length).toBeGreaterThan(0);
  });

  it("в промпт уходят заголовки, а не тела прошлых постов", async () => {
    postFindMany.mockResolvedValue([{ title: "Прошлая тема", rubric: "CASE" }]);

    await buildWeeklyPlan(NOW);

    // Двадцать полных текстов — это тысячи входных токенов на каждый запуск.
    const select = (postFindMany.mock.calls[0]?.[0] as { select: Record<string, unknown> }).select;
    expect(select).toEqual({ title: true, rubric: true });
  });

  it("расход генерации учитывается отдельной статьёй", async () => {
    await buildWeeklyPlan(NOW);
    const call = llmChatMock.mock.calls[0]?.[0] as { feature: string; maxTokens: number };
    expect(call.feature).toBe("sales.content_plan");
    // Без потолка один разболтавшийся ответ заметно съедает дневной лимит.
    expect(call.maxTokens).toBeGreaterThan(0);
  });
});
