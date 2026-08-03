import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Автопостинг: защита от второго поста в канале.
 *
 * Публикация — единственное необратимое действие в системе, которое видят
 * посторонние. Все тесты ниже про одно: система скорее не опубликует пост,
 * чем опубликует его дважды.
 */

const publishToChannel = vi.fn(async (..._a: unknown[]) => ({ kind: "published", messageId: 1 }) as unknown);
const notifyOwner = vi.fn(async (..._a: unknown[]) => true);
const channelId = vi.fn(() => "@agentus_channel" as string | null);

const findMany = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const updateMany = vi.fn(async (..._a: unknown[]) => ({ count: 1 }));
const eventCreate = vi.fn(async (..._a: unknown[]) => ({ id: "e1" }));

vi.mock("@/core/telegram/bot", () => ({
  tgPublishToChannel: (...a: unknown[]) => publishToChannel(...a),
  tgNotifyOwner: (...a: unknown[]) => notifyOwner(...a),
  contentChannelId: () => channelId(),
}));

vi.mock("@/core/db", () => ({
  prisma: {
    contentPost: {
      findMany: (...a: unknown[]) => findMany(...a),
      updateMany: (...a: unknown[]) => updateMany(...a),
    },
    domainEvent: { create: (...a: unknown[]) => eventCreate(...a) },
  },
}));

const { publishDuePosts, resolveUncertain } = await import("./publish");

const NOW = new Date("2026-08-03T09:00:00Z");

function post(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    title: "Как автосервис перестал терять заявки",
    body: "Текст поста.",
    editedBody: null,
    scheduledAt: new Date("2026-08-03T08:58:00Z"),
    publishAttempts: 0,
    ...over,
  };
}

/** Записи, переводящие пост в конкретный статус. */
function writesTo(status: string) {
  return updateMany.mock.calls
    .map((c) => c[0] as { data?: Record<string, unknown> })
    .filter((c) => c.data?.status === status);
}

beforeEach(() => {
  publishToChannel.mockReset();
  notifyOwner.mockReset().mockResolvedValue(true);
  channelId.mockReset().mockReturnValue("@agentus_channel");
  findMany.mockReset().mockResolvedValue([]);
  updateMany.mockReset().mockResolvedValue({ count: 1 });
  eventCreate.mockReset().mockResolvedValue({ id: "e1" });
});

describe("успешная публикация", () => {
  it("пост уходит в канал и получает message_id", async () => {
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([post()]);
    publishToChannel.mockResolvedValue({ kind: "published", messageId: 4242 });

    const res = await publishDuePosts(NOW);

    expect(res.published).toBe(1);
    const done = writesTo("PUBLISHED")[0];
    expect(done?.data?.externalId).toBe("4242");
    // Успех в ленту, но не в Telegram: бот, отчитывающийся по любому поводу,
    // перестают читать.
    expect(eventCreate).toHaveBeenCalled();
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("публикуется правка владельца, а не исходный текст модели", async () => {
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      post({ body: "Черновик модели", editedBody: "Как написал владелец" }),
    ]);
    publishToChannel.mockResolvedValue({ kind: "published", messageId: 1 });

    await publishDuePosts(NOW);

    expect(publishToChannel.mock.calls[0]?.[0]).toBe("Как написал владелец");
  });
});

describe("неопределённый исход не повторяется никогда", () => {
  it("таймаут уводит пост в UNCERTAIN и зовёт владельца", async () => {
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([post()]);
    publishToChannel.mockResolvedValue({ kind: "uncertain", reason: "таймаут: 15s" });

    const res = await publishDuePosts(NOW);

    expect(res.uncertain).toBe(1);
    expect(writesTo("UNCERTAIN")).toHaveLength(1);
    // В расписание пост НЕ возвращается: это был бы второй пост у подписчиков.
    expect(writesTo("SCHEDULED")).toHaveLength(0);
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(String(notifyOwner.mock.calls[0]?.[0])).toContain("Не знаю");
  });

  it("застрявший в PUBLISHING уходит в UNCERTAIN, а не отдаётся следующему прогону", async () => {
    // Контейнер умер посреди отправки. Telegram мог принять сообщение —
    // переиспользовать замок, как это делает лидоген со своими джобами,
    // здесь нельзя.
    findMany
      .mockResolvedValueOnce([{ id: "p9", title: "Застрявший" }])
      .mockResolvedValueOnce([]);

    const res = await publishDuePosts(NOW);

    expect(res.uncertain).toBe(1);
    const write = writesTo("UNCERTAIN")[0];
    expect((write?.data?.publishError as string) ?? "").toMatch(/оборвал/i);
    expect(publishToChannel).not.toHaveBeenCalled();
  });
});

describe("захват поста", () => {
  it("счётчик попыток растёт ДО отправки", async () => {
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([post()]);
    publishToChannel.mockResolvedValue({ kind: "published", messageId: 1 });

    await publishDuePosts(NOW);

    const claim = writesTo("PUBLISHING")[0];
    expect(claim?.data?.publishAttempts).toEqual({ increment: 1 });
    // Захват произошёл раньше отправки: иначе упавший посреди неё прогон
    // повторил бы попытку с нулём в счётчике.
    const claimIndex = updateMany.mock.invocationCallOrder[0] ?? 0;
    const sendIndex = publishToChannel.mock.invocationCallOrder[0] ?? 0;
    expect(claimIndex).toBeLessThan(sendIndex);
  });

  it("пост, который успел взять другой прогон, не отправляется", async () => {
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([post()]);
    updateMany.mockResolvedValue({ count: 0 });

    const res = await publishDuePosts(NOW);

    expect(publishToChannel).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
  });
});

describe("просроченное и пустое", () => {
  it("пост, просроченный на сутки, сам в канал не идёт", async () => {
    // После суточного простоя первый же тик иначе вывалил бы в канал вчерашнюю
    // пачку. Вчерашний пост в четыре утра хуже, чем невышедший.
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      post({ scheduledAt: new Date("2026-08-02T09:00:00Z") }),
    ]);

    const res = await publishDuePosts(NOW);

    expect(publishToChannel).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
    expect(writesTo("UNCERTAIN")).toHaveLength(1);
  });

  it("пост без текста помечается провальным, а не отправляется пустым", async () => {
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([post({ body: null, editedBody: "   " })]);

    const res = await publishDuePosts(NOW);

    expect(publishToChannel).not.toHaveBeenCalled();
    expect(res.failed).toBe(1);
    expect(writesTo("FAILED")).toHaveLength(1);
  });
});

describe("осмысленный отказ", () => {
  it("первые отказы возвращают пост в расписание", async () => {
    // Бот не админ канала — сообщения в канале точно нет, повтор безопасен.
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([post()]);
    publishToChannel.mockResolvedValue({ kind: "rejected", reason: "HTTP 403 bot is not a member" });

    await publishDuePosts(NOW);

    expect(writesTo("SCHEDULED")).toHaveLength(1);
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("после третьей неудачи сдаёмся и говорим владельцу", async () => {
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([post({ publishAttempts: 2 })]);
    publishToChannel.mockResolvedValue({ kind: "rejected", reason: "HTTP 400 chat not found" });

    await publishDuePosts(NOW);

    expect(writesTo("FAILED")).toHaveLength(1);
    expect(String(notifyOwner.mock.calls[0]?.[0])).toContain("не удалось");
  });
});

describe("канал не настроен", () => {
  it("молчит, а не выглядит поломкой", async () => {
    channelId.mockReturnValue(null);
    findMany.mockResolvedValue([]);

    const res = await publishDuePosts(NOW);

    expect(res).toEqual({ published: 0, failed: 0, uncertain: 0, skipped: 0 });
    expect(publishToChannel).not.toHaveBeenCalled();
  });
});

describe("решение владельца по неопределённому посту", () => {
  it("«пост на месте» закрывает его опубликованным", async () => {
    const ok = await resolveUncertain("p1", "published", NOW);
    expect(ok).toBe(true);
    const data = (updateMany.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.status).toBe("PUBLISHED");
    expect(data.publishedAt).toEqual(NOW);
  });

  it("«вернуть в расписание» не проставляет время само", async () => {
    // Прошедшее время означало бы публикацию на ближайшем тике, а владелец
    // этого не просил.
    await resolveUncertain("p1", "reschedule", NOW);
    const data = (updateMany.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.status).toBe("APPROVED");
    expect(data.scheduledAt).toBeNull();
  });

  it("решение применяется только к посту в статусе UNCERTAIN", async () => {
    const where = (updateMany.mock.calls[0]?.[0] as { where: Record<string, unknown> })?.where;
    await resolveUncertain("p1", "published", NOW);
    const applied = (updateMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
    expect(applied.status ?? where?.status).toBe("UNCERTAIN");
  });
});
