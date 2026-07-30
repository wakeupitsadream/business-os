import { beforeEach, describe, expect, it, vi } from "vitest";
import { TZDate } from "@date-fns/tz";
import { OWNER_TZ } from "@/core/shared/time";

/**
 * Тесты утреннего брифа.
 *
 * Бриф — единственное, что владелец читает каждое утро. Поэтому здесь важнее
 * всего два свойства: он приходит один раз в день и приходит даже тогда, когда
 * модель недоступна.
 */

const llmChatMock = vi.fn();
const notifyMock = vi.fn(async (..._a: unknown[]) => true);
const briefFindUnique = vi.fn(async (..._a: unknown[]) => null as unknown);
const briefUpsert = vi.fn(async (..._a: unknown[]) => ({ id: "b1" }));
const briefUpdate = vi.fn(async (..._a: unknown[]) => ({}));

vi.mock("@/core/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/llm")>();
  return { ...actual, llmChat: (...a: unknown[]) => llmChatMock(...a) };
});

vi.mock("@/core/telegram/bot", () => ({
  tgNotifyOwner: (...a: unknown[]) => notifyMock(...a),
}));

const emptyList = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const zero = vi.fn(async (..._a: unknown[]) => 0);

vi.mock("@/core/db", () => ({
  prisma: {
    dailyBrief: {
      findUnique: (...a: unknown[]) => briefFindUnique(...a),
      upsert: (...a: unknown[]) => briefUpsert(...a),
      update: (...a: unknown[]) => briefUpdate(...a),
    },
    task: { findMany: (...a: unknown[]) => emptyList(...a), count: (...a: unknown[]) => zero(...a) },
    reminder: { findMany: (...a: unknown[]) => emptyList(...a) },
    domainEvent: { findMany: (...a: unknown[]) => emptyList(...a) },
    goal: { findMany: (...a: unknown[]) => emptyList(...a) },
    checkIn: {
      findFirst: vi.fn(async (..._a: unknown[]) => null),
      findMany: (...a: unknown[]) => emptyList(...a),
    },
  },
}));

const { briefDate, generateDailyBrief, renderBriefPlain } = await import("./brief");
const { LlmUnavailableError } = await import("@/core/llm");

beforeEach(() => {
  llmChatMock.mockReset();
  notifyMock.mockReset();
  briefFindUnique.mockReset();
  briefUpsert.mockReset();
  briefUpdate.mockReset();
  emptyList.mockReset();
  zero.mockReset();

  notifyMock.mockResolvedValue(true);
  briefFindUnique.mockResolvedValue(null);
  briefUpsert.mockResolvedValue({ id: "b1" });
  briefUpdate.mockResolvedValue({});
  emptyList.mockResolvedValue([]);
  zero.mockResolvedValue(0);
  llmChatMock.mockResolvedValue({
    text: "Доброе утро.\nЗадач немного.\nФокус дня: закрыть отчёт",
    toolCalls: [],
    rawToolCalls: null,
    gateway: "polza",
    model: "m",
    inputTokens: 1,
    outputTokens: 1,
    latencyMs: 1,
  });
});

describe("дата брифа", () => {
  it("считается по времени владельца", () => {
    // 00:30 МСК 30 июля = 21:30 UTC 29 июля: по UTC это ещё вчера.
    const afterMidnightMsk = new Date("2026-07-29T21:30:00Z");
    expect(briefDate(afterMidnightMsk).toISOString().slice(0, 10)).toBe("2026-07-30");
  });

  it("совпадает с датой на часах владельца", () => {
    const moment = new Date("2026-07-29T05:00:00Z");
    const local = new TZDate(moment, OWNER_TZ);
    expect(briefDate(moment).getUTCDate()).toBe(local.getDate());
  });
});

describe("идемпотентность", () => {
  it("второй раз за день бриф не отправляется", async () => {
    briefFindUnique.mockResolvedValue({ id: "b1", sentToTelegramAt: new Date() });

    const res = await generateDailyBrief(new Date("2026-07-29T04:30:00Z"));

    expect(res.created).toBe(false);
    expect(notifyMock).not.toHaveBeenCalled();
    expect(llmChatMock).not.toHaveBeenCalled();
  });

  it("составленный, но не отправленный бриф досылается", async () => {
    // Модель отработала, а Telegram был недоступен — на следующем тике крона
    // попытка должна повториться, иначе владелец останется без брифа.
    briefFindUnique.mockResolvedValue({ id: "b1", sentToTelegramAt: null });

    const res = await generateDailyBrief(new Date("2026-07-29T04:30:00Z"));

    expect(res.created).toBe(true);
    expect(notifyMock).toHaveBeenCalled();
  });
});

describe("бриф приходит даже без модели", () => {
  it("недоступность шлюзов не отменяет бриф", async () => {
    llmChatMock.mockRejectedValue(new LlmUnavailableError("шлюзы недоступны"));

    const res = await generateDailyBrief(new Date("2026-07-29T04:30:00Z"));

    expect(res.sent).toBe(true);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const text = String(notifyMock.mock.calls[0]?.[0]);
    expect(text).toContain("Доброе утро");
  });

  it("сбой отправки не роняет джобу", async () => {
    notifyMock.mockRejectedValue(new Error("сеть"));
    await expect(generateDailyBrief(new Date("2026-07-29T04:30:00Z"))).resolves.toMatchObject({
      created: true,
      sent: false,
    });
  });

  it("отметка об отправке ставится только при успехе", async () => {
    notifyMock.mockResolvedValue(false);
    await generateDailyBrief(new Date("2026-07-29T04:30:00Z"));
    expect(briefUpdate).not.toHaveBeenCalled();
  });
});

describe("запасной текст брифа", () => {
  const base = {
    tasksToday: [],
    overdue: [],
    reminders: [],
    yesterdayDone: 0,
    events: [],
    wellbeing: null,
    goals: [],
  };

  it("без задач сообщает об этом прямо, а не молчит", () => {
    expect(renderBriefPlain(base)).toContain("задач со сроком нет");
  });

  it("перечисляет задачи и помечает срочные", () => {
    const text = renderBriefPlain({
      ...base,
      tasksToday: [
        { id: "1", title: "Позвонить в банк", dueAt: null, priority: 1 },
        { id: "2", title: "Ответить клиенту", dueAt: null, priority: 2 },
      ],
    });
    expect(text).toContain("Позвонить в банк");
    expect(text).toContain("! Позвонить в банк");
    expect(text).toContain("Ответить клиенту");
  });

  it("при затяжном спаде предлагает поберечься, а не добавляет дел", () => {
    const text = renderBriefPlain({
      ...base,
      wellbeing: { mood: 2, energy: 2, slump: true },
    });
    expect(text).toMatch(/побереч|низкой энергии/i);
  });

  it("показывает просроченное отдельно", () => {
    const text = renderBriefPlain({
      ...base,
      overdue: [{ id: "1", title: "Забытое дело", dueAt: null }],
    });
    expect(text).toContain("Просрочено");
    expect(text).toContain("Забытое дело");
  });
});

describe("модель не получает права выдумывать числа", () => {
  it("в промпте есть прямой запрет", async () => {
    await generateDailyBrief(new Date("2026-07-29T04:30:00Z"));
    const system = String(
      (llmChatMock.mock.calls[0]?.[0] as { messages: Array<{ content: string }> }).messages[0]
        ?.content,
    );
    expect(system).toMatch(/не додумывай|ТОЛЬКО факты/i);
  });
});
