import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Дайджест касаний.
 *
 * Проверяем ровно те свойства, ради которых он существует: просроченное видно
 * как просроченное, сутки режутся по поясу владельца, а урезание списков не
 * притворяется полнотой.
 */

const followUpFindMany = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const followUpCount = vi.fn(async (..._a: unknown[]) => 0);
const leadCount = vi.fn(async (..._a: unknown[]) => 0);
const touchCount = vi.fn(async (..._a: unknown[]) => 0);
const loadBoardMock = vi.fn(async (..._a: unknown[]) => [] as unknown[]);

vi.mock("@/core/db", () => ({
  prisma: {
    followUp: {
      findMany: (...a: unknown[]) => followUpFindMany(...a),
      count: (...a: unknown[]) => followUpCount(...a),
    },
    lead: { count: (...a: unknown[]) => leadCount(...a) },
    touchPoint: { count: (...a: unknown[]) => touchCount(...a) },
  },
}));

vi.mock("./metrics", () => ({ loadBoard: (...a: unknown[]) => loadBoardMock(...a) }));

const { collectTouchDigest } = await import("./digest");
const { dayBounds } = await import("@/core/shared/time");

function stage(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "s1",
    name: "Демо",
    position: 2,
    probability: 40,
    staleAfterDays: 7,
    isWon: false,
    isLost: false,
    deals: [],
    totalKop: 0,
    ...over,
  };
}

function deal(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "d1",
    title: "Agentus",
    leadId: "l1",
    leadName: "СТО на Ленина",
    city: null,
    amountMonthlyKop: 500000,
    enteredStageAt: "2026-07-20T00:00:00Z",
    daysInStage: 10,
    isStale: true,
    nextFollowUpAt: null,
    ...over,
  };
}

beforeEach(() => {
  followUpFindMany.mockReset().mockResolvedValue([]);
  followUpCount.mockReset().mockResolvedValue(0);
  leadCount.mockReset().mockResolvedValue(0);
  touchCount.mockReset().mockResolvedValue(0);
  loadBoardMock.mockReset().mockResolvedValue([]);
});

describe("наступившие касания", () => {
  const now = new Date("2026-08-02T09:00:00Z");

  it("вчерашний срок помечен просроченным, сегодняшний — нет", async () => {
    const today = dayBounds(now);
    followUpFindMany.mockResolvedValue([
      {
        id: "f1",
        dueAt: new Date(today.start.getTime() - 3600 * 1000),
        note: "перезвонить",
        lead: { id: "l1", name: "Гараж 24" },
      },
      {
        id: "f2",
        dueAt: new Date(today.start.getTime() + 3600 * 1000),
        note: null,
        lead: { id: "l2", name: "Автосервис Кузьмич" },
      },
    ]);

    const digest = await collectTouchDigest(now);

    expect(digest.followUps[0]).toMatchObject({ leadName: "Гараж 24", overdue: true });
    expect(digest.followUps[1]).toMatchObject({ leadName: "Автосервис Кузьмич", overdue: false });
  });

  it("граница «просрочено» проходит по полуночи владельца, а не по UTC", async () => {
    // 20:00 UTC 1 августа — это 01:00 второго у владельца (UTC+5): местные
    // сутки уже сменились. Касание, назначенное на 15:00 первого (10:00 UTC),
    // для него вчерашнее и просроченное. По календарю UTC оно всё ещё
    // сегодняшнее — и бриф промолчал бы о забытом обещании.
    const afterLocalMidnight = new Date("2026-08-01T20:00:00Z");
    followUpFindMany.mockResolvedValue([
      {
        id: "f1",
        dueAt: new Date("2026-08-01T10:00:00Z"),
        note: null,
        lead: { id: "l1", name: "Вчерашний" },
      },
    ]);

    const digest = await collectTouchDigest(afterLocalMidnight);

    expect(digest.followUps[0]?.overdue).toBe(true);
  });

  it("сроки за пределами сегодняшнего дня в выборку не берутся", async () => {
    await collectTouchDigest(now);
    const where = (followUpFindMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ status: "PENDING" });

    const lt = (where.dueAt as { lt: Date }).lt;
    expect(lt.getTime()).toBe(dayBounds(now).end.getTime());
    // И это именно местная полночь, а не UTC-шная: у владельца в UTC+5 они
    // расходятся на пять часов, то есть на целый вечер чужих сроков.
    const utcEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    expect(lt.getTime()).not.toBe(utcEnd);
  });
});

describe("застрявшие сделки", () => {
  const now = new Date("2026-08-02T09:00:00Z");

  it("берутся из доски вместе с порогом стадии", async () => {
    loadBoardMock.mockResolvedValue([stage({ deals: [deal()] })]);

    const digest = await collectTouchDigest(now);

    expect(digest.staleTotal).toBe(1);
    expect(digest.stale[0]).toMatchObject({ leadName: "СТО на Ленина", stage: "Демо", daysInStage: 10 });
  });

  it("выигранные и проигранные не считаются застрявшими", async () => {
    // Сделка, лежащая в «Выиграно» полгода, — это не забытая сделка, и звать
    // владельца к ней каждое утро значит приучить его пропускать раздел.
    loadBoardMock.mockResolvedValue([
      stage({ id: "won", name: "Выиграно", isWon: true, deals: [deal({ id: "d2" })] }),
      stage({ id: "lost", name: "Проиграно", isLost: true, deals: [deal({ id: "d3" })] }),
    ]);

    const digest = await collectTouchDigest(now);

    expect(digest.staleTotal).toBe(0);
  });

  it("самые давние показываются первыми, остаток виден в счётчике", async () => {
    const deals = Array.from({ length: 8 }, (_, i) =>
      deal({ id: `d${i}`, leadName: `Лид ${i}`, daysInStage: i + 1 }),
    );
    loadBoardMock.mockResolvedValue([stage({ deals })]);

    const digest = await collectTouchDigest(now);

    expect(digest.stale).toHaveLength(5);
    expect(digest.stale[0]?.daysInStage).toBe(8);
    expect(digest.staleTotal).toBe(8);
  });
});

describe("вчерашние итоги", () => {
  it("смены стадии не считаются касаниями", async () => {
    // Перетащить карточку — не то же самое, что поговорить с клиентом. Считая
    // их вместе, бриф отчитывался бы о работе, которой не было.
    await collectTouchDigest(new Date("2026-08-02T09:00:00Z"));
    const where = (touchCount.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
    expect(where.kind).toEqual({ not: "STAGE_CHANGE" });
  });

  it("новые лиды считаются за вчерашние сутки владельца", async () => {
    const now = new Date("2026-08-02T09:00:00Z");
    const yesterday = dayBounds(new Date(now.getTime() - 24 * 3600 * 1000));

    await collectTouchDigest(now);

    const where = (leadCount.mock.calls[0]?.[0] as { where: { createdAt: { gte: Date; lt: Date } } })
      .where;
    expect(where.createdAt.gte.getTime()).toBe(yesterday.start.getTime());
    expect(where.createdAt.lt.getTime()).toBe(yesterday.end.getTime());
  });
});
