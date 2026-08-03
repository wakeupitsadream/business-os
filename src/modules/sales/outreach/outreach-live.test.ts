import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Аутрич на настоящей базе.
 *
 * Здесь проверяется DoD PR-3.4: отметка «отправил вручную» двигает воронку.
 * Это цепочка из четырёх записей в разных таблицах — касание, стадия, событие
 * и напоминание, — и мок подтвердил бы только вызовы, а не то, что осталось.
 */

const llmChatMock = vi.fn();

vi.mock("@/core/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/llm")>();
  return { ...actual, llmChat: (...a: unknown[]) => llmChatMock(...a) };
});

const { prisma } = await import("@/core/db");
const { assertDisposableDatabase } = await import("@/core/testing/live-db");
const { createLead, createDeal, CONTACTED_STAGE_ID, FIRST_STAGE_ID } = await import("../leads");
const { moveDeal } = await import("../pipeline");
const { approveDraft, markSent, rejectDraft } = await import("./actions");
const { DAILY_DRAFT_CAP, generateDrafts } = await import("./drafts");
const { loadOutreachQueue } = await import("./queue");

const live = process.env.LIVE_DB === "1";
const NOW = new Date("2026-08-02T12:00:00Z");

const GOOD_BODY =
  "Здравствуйте! Увидел ваш сервис — записываете клиентов по телефону? Могу показать, как это делается онлайн.";

function llmAnswer(body = GOOD_BODY, reasoning = "поток есть, записи нет") {
  return {
    text: JSON.stringify({ body, reasoning }),
    toolCalls: [],
    rawToolCalls: null,
    gateway: "polza",
    model: "m",
    inputTokens: 1,
    outputTokens: 1,
    latencyMs: 1,
  };
}

async function lead(phone = "+7 999 123-45-67", name = "Автосервис на Ленина") {
  const { leadId } = await createLead({ name, phone, city: "Екатеринбург" });
  return leadId;
}

async function draftFor(leadId: string) {
  return prisma.outreachDraft.create({
    data: { leadId, channel: "WHATSAPP", body: GOOD_BODY, reasoning: "почему так" },
  });
}

describe.runIf(live)("очередь аутрича", () => {
  beforeEach(async () => {
    assertDisposableDatabase();
    await prisma.outreachDraft.deleteMany({});
    await prisma.touchPoint.deleteMany({});
    await prisma.followUp.deleteMany({});
    await prisma.deal.deleteMany({});
    await prisma.contact.deleteMany({});
    await prisma.lead.deleteMany({});
    llmChatMock.mockReset();
    llmChatMock.mockResolvedValue(llmAnswer());
  });

  it("черновики составляются только тем, кого ещё не касались", async () => {
    const fresh = await lead("+7 999 111-11-11", "Нетронутый");
    const touched = await lead("+7 999 222-22-22", "Уже писали");
    await prisma.touchPoint.create({ data: { leadId: touched, kind: "CALL", body: "звонили" } });

    const res = await generateDrafts(NOW);

    expect(res.created).toBe(1);
    const drafts = await prisma.outreachDraft.findMany({ select: { leadId: true } });
    // Черновик «первого сообщения» тому, с кем разговор идёт, выглядит как
    // забывчивость и стоит дороже, чем не написать вовсе.
    expect(drafts.map((d) => d.leadId)).toEqual([fresh]);
  });

  it("второй черновик тому же лиду не составляется", async () => {
    const id = await lead();
    await generateDrafts(NOW);
    const again = await generateDrafts(NOW);

    expect(again.created).toBe(0);
    expect(await prisma.outreachDraft.count({ where: { leadId: id } })).toBe(1);
  });

  it("суточный потолок останавливает составление", async () => {
    const id = await lead();
    // Потолок стоит на СОЗДАНИИ: сотня черновиков в очереди — это не выбор, а
    // повод отправлять не глядя.
    for (let i = 0; i < DAILY_DRAFT_CAP; i += 1) {
      await prisma.outreachDraft.create({
        // Дата проставляется явно: потолок считается по суткам ВЛАДЕЛЬЦА, а
        // `now()` базы в тесте на фиксированный момент попадёт в другой день.
        data: { leadId: id, body: `${GOOD_BODY} ${i}`, status: "REJECTED", createdAt: NOW },
      });
    }

    const res = await generateDrafts(NOW);

    expect(res.created).toBe(0);
    expect(res.reason).toMatch(/потолок/);
    expect(llmChatMock).not.toHaveBeenCalled();
  });

  it("недоступная модель не оставляет после себя шаблон", async () => {
    // Безликое «предлагаем сотрудничество» от имени владельца хуже молчания.
    await lead();
    llmChatMock.mockRejectedValue(new Error("шлюзы недоступны"));

    const res = await generateDrafts(NOW);

    expect(res.created).toBe(0);
    expect(await prisma.outreachDraft.count()).toBe(0);
  });

  it("обрывок вместо сообщения в очередь не попадает", async () => {
    await lead();
    llmChatMock.mockResolvedValue(llmAnswer("Здравствуйте!"));

    await generateDrafts(NOW);

    expect(await prisma.outreachDraft.count()).toBe(0);
  });
});

describe.runIf(live)("«отправил вручную» двигает воронку", () => {
  beforeEach(async () => {
    assertDisposableDatabase();
    await prisma.outreachDraft.deleteMany({});
    await prisma.touchPoint.deleteMany({});
    await prisma.followUp.deleteMany({});
    await prisma.deal.deleteMany({});
    await prisma.contact.deleteMany({});
    await prisma.lead.deleteMany({});
  });

  it("заводит сделку, пишет касание, двигает стадию и ставит возврат", async () => {
    const leadId = await lead();
    const draft = await draftFor(leadId);

    const res = await markSent(draft.id, NOW);

    const deal = await prisma.deal.findUniqueOrThrow({ where: { id: res.dealId } });
    expect(deal.stageId).toBe(CONTACTED_STAGE_ID);
    expect(res.moved).toBe(true);

    const touches = await prisma.touchPoint.findMany({ where: { leadId } });
    expect(touches.map((t) => t.kind).sort()).toEqual(["MESSAGE_WA", "STAGE_CHANGE"]);

    const followUp = await prisma.followUp.findFirstOrThrow({ where: { leadId } });
    // Три дня — ровно столько, чтобы не выглядеть навязчивым и не забыть.
    expect(followUp.dueAt.getTime()).toBe(NOW.getTime() + 3 * 24 * 3600 * 1000);
    expect(followUp.origin).toBe("AUTO_RULE");

    const stored = await prisma.outreachDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(stored.status).toBe("SENT");
    expect(stored.dealId).toBe(res.dealId);
  });

  it("сделку, ушедшую дальше, назад не откатывает", async () => {
    // Черновик мог пролежать в очереди, пока по лиду уже шло демо.
    const leadId = await lead();
    const { dealId } = await createDeal({ leadId });
    await moveDeal({ dealId, toStageId: "stage_demo" });
    const draft = await draftFor(leadId);

    const res = await markSent(draft.id, NOW);

    expect(res.moved).toBe(false);
    const deal = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
    expect(deal.stageId).toBe("stage_demo");
    // Касание всё равно записано: сообщение-то отправили.
    expect(await prisma.touchPoint.count({ where: { leadId, kind: "MESSAGE_WA" } })).toBe(1);
  });

  it("повторная отметка отказывает, а не удваивает касания", async () => {
    const leadId = await lead();
    const draft = await draftFor(leadId);
    await markSent(draft.id, NOW);

    await expect(markSent(draft.id, NOW)).rejects.toThrow(/уже отмечен/);
    expect(await prisma.touchPoint.count({ where: { leadId, kind: "MESSAGE_WA" } })).toBe(1);
    expect(await prisma.followUp.count({ where: { leadId } })).toBe(1);
  });

  it("отклонённый черновик отправленным не отмечают", async () => {
    const leadId = await lead();
    const draft = await draftFor(leadId);
    await rejectDraft(draft.id);

    await expect(markSent(draft.id, NOW)).rejects.toThrow(/[Оо]тклонённ/);
    expect(await prisma.deal.count()).toBe(0);
  });

  it("правка сохраняется рядом с оригиналом и уходит в касание", async () => {
    const leadId = await lead();
    const draft = await draftFor(leadId);
    const mine = "Привет! Видел ваш сервис. Запись у вас только по телефону?";

    await approveDraft(draft.id, mine);
    await markSent(draft.id, NOW);

    const stored = await prisma.outreachDraft.findUniqueOrThrow({ where: { id: draft.id } });
    // Оригинал остаётся: на сравнении «что предложили» против «что написал
    // владелец» учатся следующие черновики.
    expect(stored.body).toBe(GOOD_BODY);
    expect(stored.editedBody).toBe(mine);

    const touch = await prisma.touchPoint.findFirstOrThrow({
      where: { leadId, kind: "MESSAGE_WA" },
    });
    expect(touch.body).toBe(mine);
  });

  it("очередь показывает правку и ссылку в мессенджер", async () => {
    const leadId = await lead();
    const draft = await draftFor(leadId);
    await approveDraft(draft.id, "Мой текст, а не предложенный, и он подлиннее сорока знаков.");

    const queue = await loadOutreachQueue(NOW);
    const row = queue.drafts.find((d) => d.id === draft.id);

    expect(row?.body).toContain("Мой текст");
    expect(row?.originalBody).toBe(GOOD_BODY);
    expect(row?.link).toContain("https://wa.me/79991234567");
    expect(row?.status).toBe("APPROVED");
  });

  it("отправленных в очереди больше нет", async () => {
    const leadId = await lead();
    const draft = await draftFor(leadId);
    await markSent(draft.id, NOW);

    const queue = await loadOutreachQueue(NOW);
    expect(queue.drafts).toHaveLength(0);
    expect(queue.sentToday).toBe(1);
  });

  it("первая стадия и вторая — те же, что в сиде воронки", async () => {
    // Константы стадий захардкожены; разъехавшись с сидом, они превратили бы
    // «отправил» в тихую ошибку.
    const stages = await prisma.pipelineStage.findMany({ select: { id: true } });
    const ids = stages.map((s) => s.id);
    expect(ids).toContain(FIRST_STAGE_ID);
    expect(ids).toContain(CONTACTED_STAGE_ID);
  });
});
