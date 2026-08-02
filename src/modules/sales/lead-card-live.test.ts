import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/core/db";
import { assertDisposableDatabase } from "@/core/testing/live-db";
import { dayBounds } from "@/core/shared/time";
import { collectTouchDigest } from "./digest";
import { loadLeadCard } from "./lead-card";
import { addTouchPoint, createDeal, createLead, scheduleFollowUp } from "./leads";
import { moveDeal } from "./pipeline";

/**
 * Карточка лида и дайджест касаний на настоящей базе.
 *
 * Моки здесь бесполезны принципиально: и карточка, и дайджест — это один
 * большой запрос каждый. Мок подтвердит, что запрос отправлен, но не то, что
 * PostgreSQL его принял и вернул именно те строки. Ошибка во вложенном
 * `select` или в фильтре по виду касания видна только здесь.
 */

const live = process.env.LIVE_DB === "1";
const NOW = new Date("2026-08-02T12:00:00Z");

describe.runIf(live)("карточка лида на живой базе", () => {
  beforeEach(async () => {
    assertDisposableDatabase();
    await prisma.touchPoint.deleteMany({});
    await prisma.followUp.deleteMany({});
    await prisma.deal.deleteMany({});
    await prisma.contact.deleteMany({});
    await prisma.lead.deleteMany({});
  });

  it("собирает контакты, сделки, обещания и историю одним запросом", async () => {
    const { leadId } = await createLead({
      name: "Автосервис на Ленина",
      phone: "+7 999 123-45-67",
      city: "Екатеринбург",
      site: "example.ru",
      contact: { name: "Пётр", role: "владелец", phone: "+7 999 123-45-67" },
    });
    const { dealId } = await createDeal({ leadId, amountMonthlyKop: 500000 });
    await addTouchPoint({ leadId, dealId, kind: "CALL", body: "договорились на демо" });
    await moveDeal({ dealId, toStageId: "stage_demo" });
    await scheduleFollowUp({
      leadId,
      dealId,
      dueAt: new Date("2026-08-01T10:00:00Z"),
      note: "перезвонить по цене",
    });

    const card = await loadLeadCard(leadId, NOW);

    expect(card?.phone).toBe("+7 999 123-45-67");
    expect(card?.contacts).toHaveLength(1);
    expect(card?.deals[0]).toMatchObject({ stageName: "Демо", amountMonthlyKop: 500000 });
    expect(card?.followUps[0]).toMatchObject({ note: "перезвонить по цене", overdue: true });

    // Лента идёт от свежего к старому: сверху перенос, под ним звонок.
    expect(card?.touches.map((t) => t.kind)).toEqual(["STAGE_CHANGE", "CALL"]);
    // Переход читается словами — meta пишет `moveDeal`, и её формат карточка
    // обязана понимать. Разъедутся — тест упадёт здесь, а не у владельца.
    expect(card?.touches[0]?.stageMove).toEqual({ from: "Новый", to: "Демо" });
  });

  it("касание не привязывается к сделке чужого лида", async () => {
    // Оба существуют, внешние ключи довольны — а история после такой записи
    // врёт в обе стороны: касание в ленте одного, сделка у другого.
    const a = await createLead({ name: "Первый", phone: "+7 999 777-88-99" });
    const b = await createLead({ name: "Второй", phone: "+7 999 666-77-88" });
    const { dealId } = await createDeal({ leadId: b.leadId });

    await expect(
      addTouchPoint({ leadId: a.leadId, dealId, kind: "CALL", body: "чужая сделка" }),
    ).rejects.toThrow(/другому лиду/);
    await expect(
      scheduleFollowUp({ leadId: a.leadId, dealId, dueAt: new Date("2026-08-05T10:00:00Z") }),
    ).rejects.toThrow(/другому лиду/);

    expect(await prisma.touchPoint.count({ where: { leadId: a.leadId } })).toBe(0);
    expect(await prisma.followUp.count({ where: { leadId: a.leadId } })).toBe(0);
  });

  it("удаление лида уносит его касания и обещания", async () => {
    const { leadId } = await createLead({ name: "Разовый", phone: "+7 999 000-11-22" });
    await addTouchPoint({ leadId, kind: "NOTE", body: "заметка" });
    await scheduleFollowUp({ leadId, dueAt: new Date("2026-08-05T10:00:00Z") });

    await prisma.lead.delete({ where: { id: leadId } });

    expect(await prisma.touchPoint.count()).toBe(0);
    expect(await prisma.followUp.count()).toBe(0);
    await expect(loadLeadCard(leadId, NOW)).resolves.toBeNull();
  });
});

describe.runIf(live)("дайджест касаний на живой базе", () => {
  beforeEach(async () => {
    assertDisposableDatabase();
    await prisma.touchPoint.deleteMany({});
    await prisma.followUp.deleteMany({});
    await prisma.deal.deleteMany({});
    await prisma.contact.deleteMany({});
    await prisma.lead.deleteMany({});
  });

  it("наступившее берёт, будущее оставляет на потом", async () => {
    const { leadId } = await createLead({ name: "Гараж 24", phone: "+7 999 111-22-33" });
    await scheduleFollowUp({ leadId, dueAt: new Date("2026-08-01T10:00:00Z"), note: "вчера" });
    await scheduleFollowUp({ leadId, dueAt: new Date("2026-08-09T10:00:00Z"), note: "через неделю" });

    const digest = await collectTouchDigest(NOW);

    expect(digest.followUpsTotal).toBe(1);
    expect(digest.overdueTotal).toBe(1);
    expect(digest.followUps[0]).toMatchObject({ leadName: "Гараж 24", overdue: true });
  });

  it("закрытое обещание из дайджеста уходит", async () => {
    const { leadId } = await createLead({ name: "Закрытый", phone: "+7 999 222-33-44" });
    const { followUpId } = await scheduleFollowUp({ leadId, dueAt: new Date("2026-08-01T10:00:00Z") });

    await prisma.followUp.update({
      where: { id: followUpId },
      data: { status: "DONE", completedAt: NOW },
    });

    const digest = await collectTouchDigest(NOW);
    expect(digest.followUpsTotal).toBe(0);
  });

  it("сделку, застрявшую дольше порога стадии, показывает со стадией", async () => {
    const { leadId } = await createLead({ name: "СТО на Ленина", phone: "+7 999 333-44-55" });
    const { dealId } = await createDeal({ leadId, amountMonthlyKop: 300000 });
    await moveDeal({ dealId, toStageId: "stage_demo" });
    // Порог стадии «Демо» — из сида; чтобы сделка стала застрявшей, старим её
    // вход в стадию, а не подменяем порог: проверять надо настоящее правило.
    await prisma.deal.update({
      where: { id: dealId },
      data: { enteredStageAt: new Date(NOW.getTime() - 30 * 24 * 3600 * 1000) },
    });

    const digest = await collectTouchDigest(NOW);

    expect(digest.staleTotal).toBe(1);
    expect(digest.stale[0]).toMatchObject({ leadName: "СТО на Ленина", stage: "Демо" });
  });

  it("вчерашние касания считает без смен стадии", async () => {
    const yesterday = dayBounds(new Date(NOW.getTime() - 24 * 3600 * 1000));
    const at = new Date(yesterday.start.getTime() + 6 * 3600 * 1000);

    const { leadId } = await createLead({ name: "Вчерашний", phone: "+7 999 444-55-66" });
    const { dealId } = await createDeal({ leadId });
    await prisma.lead.update({ where: { id: leadId }, data: { createdAt: at } });

    const call = await addTouchPoint({ leadId, dealId, kind: "CALL", body: "звонок" });
    await prisma.touchPoint.update({ where: { id: call.touchPointId }, data: { occurredAt: at } });

    await moveDeal({ dealId, toStageId: "stage_contacted" });
    await prisma.touchPoint.updateMany({ where: { kind: "STAGE_CHANGE" }, data: { occurredAt: at } });

    const digest = await collectTouchDigest(NOW);

    // Перетащить карточку — не то же самое, что поговорить с клиентом.
    expect(digest.touchesYesterday).toBe(1);
    expect(digest.newLeadsYesterday).toBe(1);
  });
});
