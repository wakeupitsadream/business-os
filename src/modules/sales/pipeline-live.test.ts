import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/core/db";
import { assertDisposableDatabase } from "@/core/testing/live-db";
import { addTouchPoint, completeFollowUp, createDeal, createLead, scheduleFollowUp } from "./leads";
import { computeOverview, loadBoard } from "./metrics";
import { PipelineError, moveDeal } from "./pipeline";

/**
 * Воронка на настоящей базе.
 *
 * Моками здесь проверять нечего: все три правила движения сделки — про то, что
 * осталось в базе после перехода, а не про то, какие функции вызвались.
 */

const live = process.env.LIVE_DB === "1";
const NOW = new Date("2026-08-02T12:00:00Z");

async function lead(name = "Автосервис на Ленина", phone: string | null = "+7 999 123-45-67") {
  const { leadId } = await createLead({ name, phone, city: "Екатеринбург" });
  return leadId;
}

describe.runIf(live)("воронка на живой базе", () => {
  beforeEach(async () => {
    assertDisposableDatabase();
    await prisma.touchPoint.deleteMany({});
    await prisma.followUp.deleteMany({});
    await prisma.deal.deleteMany({});
    await prisma.contact.deleteMany({});
    await prisma.lead.deleteMany({});
  });

  it("сид воронки на месте и в правильном порядке", async () => {
    const stages = await prisma.pipelineStage.findMany({ orderBy: { position: "asc" } });
    expect(stages.map((s) => s.id)).toEqual([
      "stage_new",
      "stage_contacted",
      "stage_demo",
      "stage_trial",
      "stage_won",
      "stage_lost",
    ]);
    // У терминальных стадий срока «застревания» нет: застрять в «выиграно»
    // нельзя, а карточка с пометкой там смотрелась бы упрёком.
    expect(stages.find((s) => s.isWon)?.staleAfterDays).toBeNull();
    expect(stages.find((s) => s.isLost)?.staleAfterDays).toBeNull();
  });

  it("лид с тем же телефоном не заводится второй раз", async () => {
    // Один автосервис приезжает из Яндекса и из заявки на сайте под разными
    // названиями. Без склейки владелец звонит человеку дважды.
    const first = await createLead({ name: "Автосервис на Ленина", phone: "+7 999 123-45-67" });
    const second = await createLead({
      name: 'ИП Кузнецов А.А.',
      phone: "8 (999) 123-45-67",
      city: "Екатеринбург",
      site: "https://example.ru",
    });

    expect(second.merged).toBe(true);
    expect(second.leadId).toBe(first.leadId);
    expect(await prisma.lead.count()).toBe(1);

    // Название владельца не затирается: свежий источник не обязательно точнее.
    const stored = await prisma.lead.findUniqueOrThrow({ where: { id: first.leadId } });
    expect(stored.name).toBe("Автосервис на Ленина");
    // А пустое — дописывается.
    expect(stored.site).toBe("https://example.ru");
  });

  it("лиды без телефона друг другу не мешают", async () => {
    // NULL в уникальном индексе не конфликтует сам с собой — иначе вторая
    // заявка с сайта без телефона не сохранилась бы вовсе.
    await createLead({ name: "Заявка 1", phone: null, source: "INBOUND_SITE" });
    await createLead({ name: "Заявка 2", phone: "", source: "INBOUND_SITE" });
    expect(await prisma.lead.count()).toBe(2);
  });

  it("движение по воронке пишет касание и переставляет счётчик стадии", async () => {
    const leadId = await lead();
    const { dealId } = await createDeal({ leadId, amountMonthlyKop: 15_000_00 });

    const res = await moveDeal({ dealId, toStageId: "stage_contacted" });
    expect(res.moved).toBe(true);

    const deal = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
    expect(deal.stageId).toBe("stage_contacted");

    // История сделки без этого читалась бы как «ничего не происходило».
    const touch = await prisma.touchPoint.findFirstOrThrow({
      where: { dealId, kind: "STAGE_CHANGE" },
    });
    expect(touch.meta).toMatchObject({
      fromStageId: "stage_new",
      toStageId: "stage_contacted",
    });
  });

  it("проигрыш без причины не проходит", async () => {
    // «Почему не покупают» — главный вопрос, ради которого воронку и ведут.
    const leadId = await lead();
    const { dealId } = await createDeal({ leadId });

    await expect(moveDeal({ dealId, toStageId: "stage_lost" })).rejects.toThrow(PipelineError);

    const deal = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
    expect(deal.stageId).toBe("stage_new");
    expect(await prisma.touchPoint.count()).toBe(0);
  });

  it("возврат из проигранных снимает причину", async () => {
    // Иначе живая сделка всплывает в статистике потерь как «проиграли по цене».
    const leadId = await lead();
    const { dealId } = await createDeal({ leadId });

    await moveDeal({ dealId, toStageId: "stage_lost", lostReason: "PRICE" });
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: dealId } })).lostReason).toBe("PRICE");

    await moveDeal({ dealId, toStageId: "stage_contacted" });
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: dealId } })).lostReason).toBeNull();
  });

  it("бросок карточки в ту же колонку не обнуляет возраст сделки", async () => {
    // Перебор канбана не событие. Обнулять им время на стадии значит терять
    // «застрявших» ровно тогда, когда владелец их и перебирает.
    const leadId = await lead();
    const { dealId } = await createDeal({ leadId });
    const long = new Date(NOW.getTime() - 10 * 24 * 3600 * 1000);
    await prisma.deal.update({ where: { id: dealId }, data: { enteredStageAt: long } });

    const res = await moveDeal({ dealId, toStageId: "stage_new" });

    expect(res.moved).toBe(false);
    const deal = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
    expect(deal.enteredStageAt.toISOString()).toBe(long.toISOString());
    expect(await prisma.touchPoint.count()).toBe(0);
  });

  it("смену стадии нельзя подделать ручным касанием", async () => {
    const leadId = await lead();
    await expect(addTouchPoint({ leadId, kind: "STAGE_CHANGE" })).rejects.toThrow(PipelineError);
  });

  it("ближайшее касание денормализуется на лида и снимается при закрытии", async () => {
    const leadId = await lead();
    const soon = new Date(NOW.getTime() + 2 * 24 * 3600 * 1000);
    const later = new Date(NOW.getTime() + 5 * 24 * 3600 * 1000);

    const late = await scheduleFollowUp({ leadId, dueAt: later });
    await scheduleFollowUp({ leadId, dueAt: soon });

    let stored = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(stored.nextFollowUpAt?.toISOString()).toBe(soon.toISOString());

    // Закрыли ближайшее — на его место встаёт следующее, а не null.
    const pending = await prisma.followUp.findFirstOrThrow({ where: { leadId, dueAt: soon } });
    await completeFollowUp(pending.id);
    stored = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(stored.nextFollowUpAt?.toISOString()).toBe(later.toISOString());

    await completeFollowUp(late.followUpId);
    stored = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(stored.nextFollowUpAt).toBeNull();
  });

  it("KPI сходятся с содержимым доски", async () => {
    // Взвешенный потенциал честнее суммы по списку: сделка в «новых» стоит 5%
    // от своей суммы, а не 100%.
    const a = await lead("Первый", "+7 999 111-11-11");
    const b = await lead("Второй", "+7 999 222-22-22");
    const dealA = await createDeal({ leadId: a, amountMonthlyKop: 10_000_00 });
    const dealB = await createDeal({ leadId: b, amountMonthlyKop: 20_000_00 });
    await moveDeal({ dealId: dealB.dealId, toStageId: "stage_demo" });

    const overview = await computeOverview(NOW);
    expect(overview.activeDeals).toBe(2);
    expect(overview.activeAmountKop).toBe(30_000_00);
    // 10 000 × 5% + 20 000 × 40% = 500 + 8 000 = 8 500 ₽.
    expect(overview.weightedAmountKop).toBe(8_500_00);

    const board = await loadBoard(NOW);
    const fromBoard = board
      .filter((s) => !s.isWon && !s.isLost)
      .reduce((sum, s) => sum + s.totalKop, 0);
    expect(fromBoard).toBe(overview.activeAmountKop);
    void dealA;
  });

  it("застрявшая сделка помечается по своей стадии, а не по общему сроку", async () => {
    // У «новых» порог 3 дня, у «пробных» — 14: сделка на пробном периоде живёт
    // медленнее по своей природе, и общий срок ругал бы её зря.
    const leadId = await lead();
    const { dealId } = await createDeal({ leadId });
    await prisma.deal.update({
      where: { id: dealId },
      data: { enteredStageAt: new Date(NOW.getTime() - 5 * 24 * 3600 * 1000) },
    });

    let board = await loadBoard(NOW);
    expect(board.find((s) => s.id === "stage_new")?.deals[0]?.isStale).toBe(true);

    await moveDeal({ dealId, toStageId: "stage_trial" });
    await prisma.deal.update({
      where: { id: dealId },
      data: { enteredStageAt: new Date(NOW.getTime() - 5 * 24 * 3600 * 1000) },
    });
    board = await loadBoard(NOW);
    expect(board.find((s) => s.id === "stage_trial")?.deals[0]?.isStale).toBe(false);
  });
});
