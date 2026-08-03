import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/core/db";
import { assertDisposableDatabase, liveDbEnabled } from "@/core/testing/live-db";
import { collectReviewMetrics, lastWeekBounds } from "./review-metrics";
import { createLead, createDeal } from "./leads";
import { moveDeal } from "./pipeline";

/**
 * Метрики разбора на живой базе.
 *
 * Мок здесь бесполезен: конверсии считаются рекурсивным SQL по ленте
 * переходов, и проверять надо, что PostgreSQL вернул те числа, а не что
 * функция вызвалась.
 */

// Разбор запускается в понедельник 10 августа и смотрит на неделю 3–9 августа.
const MONDAY = new Date("2026-08-10T03:00:00Z");
const INSIDE = new Date("2026-08-05T09:00:00Z");

describe.runIf(liveDbEnabled)("метрики разбора на живой базе", () => {
  beforeEach(async () => {
    assertDisposableDatabase();
    await prisma.touchPoint.deleteMany({});
    await prisma.followUp.deleteMany({});
    await prisma.customer.deleteMany({});
    await prisma.deal.deleteMany({});
    await prisma.lead.deleteMany({});
  });

  it("разбирается ПРОШЛАЯ неделя, а не начавшаяся", () => {
    const { start, end } = lastWeekBounds(MONDAY);
    expect(start.toISOString()).toBe("2026-08-02T19:00:00.000Z"); // Пн 3 авг, 00:00 местного
    expect(end.toISOString()).toBe("2026-08-09T19:00:00.000Z");
  });

  it("конверсия считается по ленте, а не по текущей стадии сделки", async () => {
    // Сделка, прошедшая всю воронку, в снимке видна ОДИН раз — как выигранная.
    // По снимку конверсии «новый → связались» не существует вовсе.
    const lead = await createLead({ name: "Автосервис Кузьмич", source: "MANUAL" });
    const deal = await createDeal({ leadId: lead.leadId, title: "Подписка", amountMonthlyKop: 500_000 });

    await prisma.deal.update({ where: { id: deal.dealId }, data: { createdAt: INSIDE } });
    await moveDeal({ dealId: deal.dealId, toStageId: "stage_contacted" });
    await moveDeal({ dealId: deal.dealId, toStageId: "stage_demo" });
    await prisma.touchPoint.updateMany({ data: { occurredAt: INSIDE } });

    const metrics = await collectReviewMetrics(MONDAY);
    const fromNew = metrics.conversions.find((c) => c.fromStageId === "stage_new");

    expect(fromNew?.entered).toBe(1);
    expect(fromNew?.advanced).toBe(1);
  });

  it("вход в первую стадию учитывается, хотя касания для него нет", async () => {
    // createDeal ставит стадию сразу и STAGE_CHANGE не пишет: без явного учёта
    // createdAt знаменатель первой конверсии занижался бы на все сделки,
    // которые ни разу не двигали.
    const lead = await createLead({ name: "Шиномонтаж на Ленина", source: "MANUAL" });
    const deal = await createDeal({ leadId: lead.leadId, title: "Подписка" });
    await prisma.deal.update({ where: { id: deal.dealId }, data: { createdAt: INSIDE } });

    const metrics = await collectReviewMetrics(MONDAY);
    const fromNew = metrics.conversions.find((c) => c.fromStageId === "stage_new");

    expect(fromNew?.entered).toBe(1);
    expect(fromNew?.advanced).toBe(0);
  });

  it("проигрыш не засчитывается как прохождение воронки", async () => {
    // У проигранной стадии позиция БОЛЬШЕ, чем у выигранной: без фильтра
    // проигрыш читался бы как «прошёл дальше всех».
    const lead = await createLead({ name: "Мойка Блеск", source: "MANUAL" });
    const deal = await createDeal({ leadId: lead.leadId, title: "Подписка" });
    await prisma.deal.update({ where: { id: deal.dealId }, data: { createdAt: INSIDE } });
    await moveDeal({ dealId: deal.dealId, toStageId: "stage_lost", lostReason: "PRICE" });
    await prisma.touchPoint.updateMany({ data: { occurredAt: INSIDE } });

    const metrics = await collectReviewMetrics(MONDAY);
    const fromNew = metrics.conversions.find((c) => c.fromStageId === "stage_new");

    expect(fromNew?.advanced).toBe(0);
    expect(metrics.dealsLost).toBe(1);
  });

  it("причина проигрыша переживает возврат сделки в работу", async () => {
    // moveDeal обнуляет Deal.lostReason при возврате: статистика по снимку
    // потеряла бы проигрыш задним числом.
    const lead = await createLead({ name: "Сервис Мотор", source: "MANUAL" });
    const deal = await createDeal({ leadId: lead.leadId, title: "Подписка" });
    await moveDeal({ dealId: deal.dealId, toStageId: "stage_lost", lostReason: "COMPETITOR" });
    await moveDeal({ dealId: deal.dealId, toStageId: "stage_contacted" });
    await prisma.touchPoint.updateMany({ data: { occurredAt: INSIDE } });

    const metrics = await collectReviewMetrics(MONDAY);

    expect(metrics.lostReasons).toContainEqual({ reason: "COMPETITOR", count: 1 });
    const after = await prisma.deal.findUniqueOrThrow({ where: { id: deal.dealId } });
    expect(after.lostReason).toBeNull();
  });

  it("проценты не показываются, когда данных мало", async () => {
    const lead = await createLead({ name: "Один лид", source: "MANUAL" });
    const deal = await createDeal({ leadId: lead.leadId, title: "Подписка" });
    await prisma.deal.update({ where: { id: deal.dealId }, data: { createdAt: INSIDE } });

    const metrics = await collectReviewMetrics(MONDAY);

    // «Конверсия 0%» на одной сделке — не метрика, а шум.
    expect(metrics.thin).toBe(true);
    expect(metrics.conversions.every((c) => c.rate === null)).toBe(true);
  });

  it("пропущенные обещания не считаются выполненными", async () => {
    // completeFollowUp проставляет дату завершения и SKIPPED тоже: фильтр по
    // её наличию сделал бы дисциплину тем выше, чем больше забыто.
    const lead = await createLead({ name: "Клиент с обещанием", source: "MANUAL" });
    await prisma.followUp.createMany({
      data: [
        { leadId: lead.leadId, dueAt: INSIDE, status: "DONE", completedAt: INSIDE, origin: "MANUAL" },
        { leadId: lead.leadId, dueAt: INSIDE, status: "SKIPPED", completedAt: INSIDE, origin: "MANUAL" },
        { leadId: lead.leadId, dueAt: INSIDE, status: "PENDING", origin: "MANUAL" },
      ],
    });

    const metrics = await collectReviewMetrics(MONDAY);

    expect(metrics.touches.promised).toBe(3);
    expect(metrics.touches.done).toBe(1);
    expect(metrics.touches.skipped).toBe(1);
  });

  it("пустая неделя не роняет разбор", async () => {
    const metrics = await collectReviewMetrics(MONDAY);

    expect(metrics.dealsCreated).toBe(0);
    expect(metrics.thin).toBe(true);
    expect(metrics.conversions).toEqual([]);
    expect(metrics.lostReasons).toEqual([]);
  });
});
