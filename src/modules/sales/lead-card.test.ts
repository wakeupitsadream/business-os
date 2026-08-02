import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Карточка лида.
 *
 * Главное свойство — терпимость к полям, которых карточка не понимает.
 * `aiScoreData` и `aiNextStep` пишет лидоген, формат у них ещё будет меняться,
 * и карточка обязана открыться при любом их содержимом: не разобрали — не
 * показали, всё остальное показали.
 */

const leadFindUnique = vi.fn(async (..._a: unknown[]) => null as unknown);

vi.mock("@/core/db", () => ({
  prisma: { lead: { findUnique: (...a: unknown[]) => leadFindUnique(...a) } },
}));

const { loadLeadCard, parseNextStep, parseScoreReasons } = await import("./lead-card");

const NOW = new Date("2026-08-02T12:00:00Z");

function lead(over: Record<string, unknown> = {}) {
  return {
    id: "l1",
    name: "Автосервис Кузьмич",
    niche: "AUTO_SERVICE",
    city: "Екатеринбург",
    source: "YANDEX_GEO",
    phoneNormalized: "79991234567",
    site: null,
    address: null,
    note: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    aiScore: null,
    aiScoreData: null,
    aiNextStep: null,
    contacts: [],
    deals: [],
    followUps: [],
    touchPoints: [],
    ...over,
  };
}

beforeEach(() => {
  leadFindUnique.mockReset().mockResolvedValue(null);
});

describe("разбор полей ИИ", () => {
  it("годное предложение разбирается целиком", () => {
    expect(parseNextStep({ action: "Позвонить и предложить демо", why: "не отвечал", dueInDays: 2 })).toEqual({
      action: "Позвонить и предложить демо",
      why: "не отвечал",
      dueInDays: 2,
    });
  });

  it.each([
    ["пусто", null],
    ["строка вместо объекта", "позвонить"],
    ["нет действия", { why: "просто так" }],
    ["действие не строка", { action: 42 }],
    ["мусор от старого формата", { steps: [{ do: "call" }] }],
  ])("%s даёт null, а не падение", (_name, raw) => {
    expect(parseNextStep(raw)).toBeNull();
  });

  it("основания оценки читаются, а неизвестная форма даёт пустой список", () => {
    expect(parseScoreReasons({ reasons: ["есть сайт", "нет онлайн-записи"] })).toEqual([
      "есть сайт",
      "нет онлайн-записи",
    ]);
    expect(parseScoreReasons({ score: 72 })).toEqual([]);
    expect(parseScoreReasons(null)).toEqual([]);
  });
});

describe("карточка", () => {
  it("несуществующий лид — null, а не ошибка", async () => {
    await expect(loadLeadCard("нет-такого", NOW)).resolves.toBeNull();
  });

  it("телефон показывается человеческим, но остаётся тем же номером", async () => {
    leadFindUnique.mockResolvedValue(lead());
    const card = await loadLeadCard("l1", NOW);
    expect(card?.phone).toBe("+7 999 123-45-67");
  });

  it("битые поля ИИ не мешают открыть карточку", async () => {
    leadFindUnique.mockResolvedValue(
      lead({ aiScore: 72, aiScoreData: "не json-объект", aiNextStep: { нет: "действия" } }),
    );

    const card = await loadLeadCard("l1", NOW);

    expect(card?.aiScore).toBe(72);
    expect(card?.aiNextStep).toBeNull();
    expect(card?.aiScoreReasons).toEqual([]);
  });

  it("возраст сделки на стадии считается от enteredStageAt", async () => {
    leadFindUnique.mockResolvedValue(
      lead({
        deals: [
          {
            id: "d1",
            title: "Agentus",
            stageId: "stage_demo",
            amountMonthlyKop: 500000,
            enteredStageAt: new Date("2026-07-23T12:00:00Z"),
            lostReason: null,
            stage: { name: "Демо", isWon: false, isLost: false },
          },
        ],
      }),
    );

    const card = await loadLeadCard("l1", NOW);

    expect(card?.deals[0]).toMatchObject({ stageName: "Демо", daysInStage: 10 });
  });

  it("смена стадии в ленте читается словами, а не идентификаторами", async () => {
    leadFindUnique.mockResolvedValue(
      lead({
        touchPoints: [
          {
            id: "t1",
            kind: "STAGE_CHANGE",
            body: null,
            occurredAt: new Date("2026-07-30T10:00:00Z"),
            meta: {
              fromStageId: "stage_new",
              fromStageName: "Новый",
              toStageId: "stage_demo",
              toStageName: "Демо",
            },
          },
          {
            id: "t2",
            kind: "CALL",
            body: "договорились созвониться в пятницу",
            occurredAt: new Date("2026-07-29T10:00:00Z"),
            meta: { channel: "mobile" },
          },
        ],
      }),
    );

    const card = await loadLeadCard("l1", NOW);

    expect(card?.touches[0]?.stageMove).toEqual({ from: "Новый", to: "Демо" });
    // У обычного касания meta своя — и её нельзя выдавать за переход стадии.
    expect(card?.touches[1]?.stageMove).toBeNull();
  });

  it("незакрытое касание с прошедшим сроком помечено просроченным", async () => {
    leadFindUnique.mockResolvedValue(
      lead({
        followUps: [
          {
            id: "f1",
            dueAt: new Date("2026-08-01T10:00:00Z"),
            note: "перезвонить",
            origin: "MANUAL",
          },
          { id: "f2", dueAt: new Date("2026-08-05T10:00:00Z"), note: null, origin: "AUTO_RULE" },
        ],
      }),
    );

    const card = await loadLeadCard("l1", NOW);

    expect(card?.followUps[0]?.overdue).toBe(true);
    expect(card?.followUps[1]?.overdue).toBe(false);
  });

  it("в ленту берутся только незакрытые касания и последние сорок событий", async () => {
    leadFindUnique.mockResolvedValue(lead());
    await loadLeadCard("l1", NOW);

    const select = (
      leadFindUnique.mock.calls[0]?.[0] as {
        select: {
          followUps: { where: { status: string } };
          touchPoints: { take: number; orderBy: { occurredAt: string } };
        };
      }
    ).select;
    expect(select.followUps.where).toEqual({ status: "PENDING" });
    expect(select.touchPoints).toMatchObject({ take: 40, orderBy: { occurredAt: "desc" } });
  });
});
