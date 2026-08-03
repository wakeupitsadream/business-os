import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Тревоги владельцу.
 *
 * Система, пишущая о каждой ошибке, читается ровно один раз — дальше её
 * пролистывают, и настоящая авария теряется среди шума. Поэтому тесты ниже
 * в основном про то, когда тревога НЕ отправляется.
 */

const notifyOwner = vi.fn(async (..._a: unknown[]) => true);
const eventFindFirst = vi.fn(async (..._a: unknown[]) => null as unknown);
const eventCount = vi.fn(async (..._a: unknown[]) => 0);
const eventCreate = vi.fn(async (..._a: unknown[]) => ({ id: "e1" }));

vi.mock("@/core/telegram/bot", () => ({
  tgNotifyOwner: (...a: unknown[]) => notifyOwner(...a),
}));

vi.mock("@/core/db", () => ({
  prisma: {
    domainEvent: {
      findFirst: (...a: unknown[]) => eventFindFirst(...a),
      count: (...a: unknown[]) => eventCount(...a),
      create: (...a: unknown[]) => eventCreate(...a),
    },
  },
}));

const { alertOwner } = await import("./alerts");

const NOW = new Date("2026-08-03T12:00:00Z");

beforeEach(() => {
  notifyOwner.mockReset().mockResolvedValue(true);
  eventFindFirst.mockReset().mockResolvedValue(null);
  eventCount.mockReset().mockResolvedValue(0);
  eventCreate.mockReset().mockResolvedValue({ id: "e1" });
});

describe("тревога доходит", () => {
  it("первая поломка своего вида отправляется", async () => {
    const res = await alertOwner("cron_failed", "Задача «daily-brief» упала: нет базы", NOW);

    expect(res.sent).toBe(true);
    const text = String(notifyOwner.mock.calls[0]?.[0]);
    expect(text).toContain("Фоновая задача падает");
    expect(text).toContain("daily-brief");
  });

  it("отметка пишется ПОСЛЕ успешной отправки", async () => {
    // Упав между шагами, мы повторим тревогу. Это лучше, чем замолчать о ней
    // навсегда, поэтому порядок именно такой.
    await alertOwner("db_down", "нет соединения", NOW);

    const sendIndex = notifyOwner.mock.invocationCallOrder[0] ?? 0;
    const markIndex = eventCreate.mock.invocationCallOrder[0] ?? 0;
    expect(sendIndex).toBeLessThan(markIndex);
  });
});

describe("система молчит, когда должна", () => {
  it("та же поломка второй раз за окно не шлётся", async () => {
    eventFindFirst.mockResolvedValue({ id: "prev" });

    const res = await alertOwner("cron_failed", "снова упала", NOW);

    expect(res.sent).toBe(false);
    expect(res.reason).toBe("duplicate");
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("дедуп различает виды поломок", async () => {
    await alertOwner("llm_down", "шлюзы легли", NOW);
    const where = (eventFindFirst.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
    expect(where.payload).toEqual({ path: ["kind"], equals: "llm_down" });
  });

  it("поток разных тревог упирается в потолок", async () => {
    // Много разных поломок разом — сам по себе признак, что сломалось что-то
    // общее. Гнать этот поток в мессенджер бессмысленно.
    eventCount.mockResolvedValue(4);

    const res = await alertOwner("db_down", "нет базы", NOW);

    expect(res.sent).toBe(false);
    expect(res.reason).toBe("capped");
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("тревога об упавшем Telegram не отправляется через Telegram", async () => {
    // Рекурсия: отправка пишет в лог, лог оборачивается в тревогу, тревога
    // снова идёт отправлять.
    notifyOwner.mockImplementation(async () => {
      const nested = await alertOwner("llm_down", "вложенная", NOW);
      expect(nested.reason).toBe("recursion");
      return true;
    });

    await alertOwner("cron_failed", "внешняя", NOW);

    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });
});

describe("тревога не ломает вызывающего", () => {
  it("отказ отправки не бросает исключение", async () => {
    notifyOwner.mockResolvedValue(false);

    const res = await alertOwner("cron_failed", "что-то", NOW);

    expect(res.sent).toBe(false);
    expect(res.reason).toBe("send_failed");
    // Отметки нет: значит следующая попытка состоится.
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it("отказ базы при дедупе не бросает исключение", async () => {
    // Тревога, уронившая вызывающий код, ломает как раз ту джобу, которая
    // пыталась пожаловаться.
    eventFindFirst.mockRejectedValue(new Error("база недоступна"));

    await expect(alertOwner("db_down", "нет базы", NOW)).resolves.toMatchObject({ sent: false });
  });
});
