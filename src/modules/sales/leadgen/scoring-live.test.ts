import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Скоринг на настоящей базе.
 *
 * Модель и походы на чужие сайты подменены: проверяется не они, а то, что
 * записывается в базу. Балл обязан совпадать с формулой, разложение — лежать
 * рядом с числом, а недоступная модель — не оставлять после себя половину
 * оценённой партии.
 */

const llmChatMock = vi.fn();
const probeMock = vi.fn();

vi.mock("@/core/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/llm")>();
  return { ...actual, llmChat: (...a: unknown[]) => llmChatMock(...a) };
});

vi.mock("./site-probe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./site-probe")>();
  return { ...actual, probeSite: (...a: unknown[]) => probeMock(...a) };
});

const { prisma } = await import("@/core/db");
const { assertDisposableDatabase } = await import("@/core/testing/live-db");
const { computeScore, scoreCandidates, HOT_SCORE } = await import("./scoring");
const { listCandidates } = await import("./candidates");
const { LlmUnavailableError } = await import("@/core/llm");

const live = process.env.LIVE_DB === "1";

function llmAnswer(items: unknown[]) {
  return {
    text: JSON.stringify({ items }),
    toolCalls: [],
    rawToolCalls: null,
    gateway: "polza",
    model: "m",
    inputTokens: 1,
    outputTokens: 1,
    latencyMs: 1,
  };
}

async function candidate(over: Record<string, unknown> = {}) {
  return prisma.parsedCompany.create({
    data: {
      source: "stub",
      externalId: `ext-${String(over.externalId ?? "1")}`,
      name: "Автосервис на Ленина",
      niche: "AUTO_SERVICE",
      city: "Екатеринбург",
      phones: [],
      site: "https://example.ru",
      rating: 4.6,
      reviewsCount: 80,
      ...over,
    } as never,
  });
}

describe.runIf(live)("скоринг кандидатов", () => {
  beforeEach(async () => {
    assertDisposableDatabase();
    await prisma.parsedCompany.deleteMany({});
    await prisma.parseJob.deleteMany({});
    llmChatMock.mockReset();
    probeMock.mockReset();
    probeMock.mockResolvedValue({ ok: true, text: "Автосервис. Запись по телефону." });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("балл совпадает с формулой, а разложение лежит рядом с числом", async () => {
    const c = await candidate();
    llmChatMock.mockResolvedValue(
      llmAnswer([
        {
          id: c.id,
          siteQuality: "poor",
          hasOnlineBooking: false,
          socialActivity: true,
          fitReason: "поток отзывов, записи нет",
          suggestedPitch: "видел ваши отзывы",
        },
      ]),
    );

    const res = await scoreCandidates();
    const stored = await prisma.parsedCompany.findUniqueOrThrow({ where: { id: c.id } });

    const expected = computeScore({
      hasSite: true,
      siteReachable: true,
      siteQuality: "poor",
      hasOnlineBooking: false,
      socialActivity: true,
      reviewsCount: 80,
      rating: 4.6,
    });

    expect(res.scored).toBe(1);
    expect(stored.score).toBe(expected.score);
    // «Почему столько» должно восстанавливаться из записи, а не из головы.
    const data = stored.scoreData as { reasons?: string[]; fitReason?: string };
    expect(data.reasons?.length).toBeGreaterThan(0);
    expect(data.fitReason).toBe("поток отзывов, записи нет");
  });

  it("недоступная модель не оставляет половину партии оценённой", async () => {
    // Оценка, собранная без главного сигнала, выглядит такой же цифрой, как
    // настоящая, и уводит владельца звонить не тем.
    const c = await candidate();
    llmChatMock.mockRejectedValue(new LlmUnavailableError("шлюзы недоступны"));

    const res = await scoreCandidates();

    expect(res.scored).toBe(0);
    expect((await prisma.parsedCompany.findUniqueOrThrow({ where: { id: c.id } })).score).toBeNull();
  });

  it("компанию, о которой модель промолчала, не оценивает наугад", async () => {
    const [a, b] = [await candidate({ externalId: "a" }), await candidate({ externalId: "b" })];
    llmChatMock.mockResolvedValue(llmAnswer([{ id: a.id, siteQuality: "ok" }]));

    const res = await scoreCandidates();

    expect(res.scored).toBe(1);
    expect(res.skipped).toBe(1);
    expect((await prisma.parsedCompany.findUniqueOrThrow({ where: { id: b.id } })).score).toBeNull();
  });

  it("уже оценённых второй раз не берёт", async () => {
    const c = await candidate();
    llmChatMock.mockResolvedValue(llmAnswer([{ id: c.id, siteQuality: "ok" }]));
    await scoreCandidates();

    llmChatMock.mockClear();
    const second = await scoreCandidates();

    expect(second.scored).toBe(0);
    expect(llmChatMock).not.toHaveBeenCalled();
  });

  it("горячие поднимаются наверх списка и помечены", async () => {
    const cold = await candidate({ externalId: "cold", name: "С записью" });
    const hot = await candidate({ externalId: "hot", name: "Без записи" });
    llmChatMock.mockResolvedValue(
      llmAnswer([
        { id: cold.id, siteQuality: "good", hasOnlineBooking: true },
        { id: hot.id, siteQuality: "poor", hasOnlineBooking: false, fitReason: "поток есть" },
      ]),
    );

    await scoreCandidates();
    const rows = await listCandidates();

    expect(rows[0]?.name).toBe("Без записи");
    expect(rows[0]?.hot).toBe(true);
    expect(rows[0]?.fitReason).toBe("поток есть");
    // У кого запись уже есть — тому нечего продавать, в горячие он не идёт.
    expect(rows[1]?.score).toBeLessThan(HOT_SCORE);
    expect(rows[1]?.hot).toBe(false);
  });

  it("лежачий сайт не мешает оценить, но считается отсутствием присутствия", async () => {
    const c = await candidate();
    probeMock.mockResolvedValue({ ok: false, reason: "unreachable" });
    llmChatMock.mockResolvedValue(
      llmAnswer([{ id: c.id, siteQuality: "good", hasOnlineBooking: true }]),
    );

    await scoreCandidates();
    const stored = await prisma.parsedCompany.findUniqueOrThrow({ where: { id: c.id } });
    const data = stored.scoreData as { signals?: { siteQuality?: string; hasOnlineBooking?: boolean } };

    // Модель не видела страницы — её ответ про качество и запись не в счёт.
    expect(data.signals?.siteQuality).toBe("none");
    expect(data.signals?.hasOnlineBooking).toBe(false);
  });
});
