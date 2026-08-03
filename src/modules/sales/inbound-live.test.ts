import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/core/db";
import { assertDisposableDatabase } from "@/core/testing/live-db";

/**
 * Приём заявок с сайта на настоящей базе.
 *
 * Проверяется главное свойство: заявка попадает в воронку, даже когда всё
 * остальное сломано. Человек заполнил форму и ждёт — недоступная модель или
 * лежащий Telegram не имеют права стоить нам лида.
 */

const notify = vi.fn(async (..._a: unknown[]) => true);
const chat = vi.fn(async (..._a: unknown[]) => ({ text: "Здравствуйте! Давайте созвонимся." }));

vi.mock("@/core/telegram/bot", () => ({
  tgNotifyOwner: (...a: unknown[]) => notify(...a),
}));

vi.mock("@/core/llm", () => ({
  llmChat: (...a: unknown[]) => chat(...a),
  LlmUnavailableError: class LlmUnavailableError extends Error {},
}));

const { acceptInboundLead } = await import("./inbound");

const live = process.env.LIVE_DB === "1";

describe.runIf(live)("входящая заявка на живой базе", () => {
  beforeEach(async () => {
    assertDisposableDatabase();
    await prisma.touchPoint.deleteMany({});
    await prisma.followUp.deleteMany({});
    await prisma.deal.deleteMany({});
    await prisma.contact.deleteMany({});
    await prisma.lead.deleteMany({});
    notify.mockReset();
    chat.mockReset();
    notify.mockResolvedValue(true);
    chat.mockResolvedValue({ text: "Здравствуйте! Давайте созвонимся." });
  });

  it("заявка сразу попадает в воронку, а не в список лидов", async () => {
    // Заявка с сайта — это уже интерес. Лид без сделки пришлось бы вручную
    // доставать из списка, и он бы там и остался.
    const res = await acceptInboundLead({
      name: "Автосервис на Ленина",
      phone: "+7 999 123-45-67",
      city: "Екатеринбург",
      message: "Хотим попробовать, сколько стоит?",
    });

    expect(res.duplicate).toBe(false);
    const deal = await prisma.deal.findUniqueOrThrow({ where: { id: res.dealId! } });
    expect(deal.stageId).toBe("stage_new");

    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: res.leadId } });
    expect(lead.source).toBe("INBOUND_SITE");
    expect(lead.phoneNormalized).toBe("79991234567");

    // Что человек написал — в ленте касаний, а не только в заметке лида.
    const touch = await prisma.touchPoint.findFirstOrThrow({ where: { leadId: res.leadId } });
    expect(touch.body).toContain("сколько стоит");
  });

  it("контакт из заявки помечается персональными данными", async () => {
    // Форму заполняет человек: минимальный состав и авто-очистка по 152-ФЗ,
    // если он так и не сконвертируется.
    const res = await acceptInboundLead({ name: "Иван", phone: "+7 999 111-22-33" });
    const contact = await prisma.contact.findFirstOrThrow({ where: { leadId: res.leadId } });
    expect(contact.isPersonalData).toBe(true);
  });

  it("повтор той же заявки не создаёт второго лида", async () => {
    // Agentus вправе ретраить: сеть моргнула, ответ потерялся.
    const first = await acceptInboundLead({
      externalId: "req-42",
      name: "Автосервис",
      phone: "+7 999 123-45-67",
    });
    const second = await acceptInboundLead({
      externalId: "req-42",
      name: "Автосервис",
      phone: "+7 999 123-45-67",
    });

    expect(second.duplicate).toBe(true);
    expect(second.leadId).toBe(first.leadId);
    expect(await prisma.lead.count()).toBe(1);
    expect(await prisma.deal.count()).toBe(1);
  });

  it("та же компания без ключа идемпотентности склеивается по телефону", async () => {
    const first = await acceptInboundLead({ name: "Автосервис", phone: "8 (999) 123-45-67" });
    const second = await acceptInboundLead({ name: "ИП Кузнецов", phone: "+79991234567" });

    expect(second.leadId).toBe(first.leadId);
    expect(await prisma.lead.count()).toBe(1);
  });

  it("недоступная модель не мешает принять заявку", async () => {
    // Черновик ответа — приятная мелочь, а не часть заявки.
    chat.mockRejectedValue(new Error("шлюзы не настроены"));

    const res = await acceptInboundLead({ name: "Клиент", phone: "+7 999 555-11-22" });

    expect(res.leadId).toBeTruthy();
    expect(await prisma.deal.count()).toBe(1);
    // Пуш всё равно уходит — без черновика, но с самой заявкой.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0]?.[0])).not.toContain("Черновик");
  });

  it("лежащий Telegram не мешает принять заявку", async () => {
    notify.mockRejectedValue(new Error("прокси недоступен"));

    const res = await acceptInboundLead({ name: "Клиент", phone: "+7 999 555-33-44" });

    expect(res.leadId).toBeTruthy();
    expect(await prisma.lead.count()).toBe(1);
  });

  it("пуш содержит телефон в читаемом виде и черновик", async () => {
    await acceptInboundLead({
      name: "Автосервис",
      phone: "89991234567",
      message: "Перезвоните",
    });

    const text = String(notify.mock.calls[0]?.[0]);
    expect(text).toContain("+7 999 123-45-67");
    expect(text).toContain("Черновик ответа");
    expect(text).toContain("Перезвоните");
  });

  it("заявка без телефона принимается и не мешает следующей такой же", async () => {
    // NULL в уникальном индексе не конфликтует сам с собой.
    await acceptInboundLead({ name: "Аноним 1", message: "напишите на почту" });
    await acceptInboundLead({ name: "Аноним 2", message: "перезвоните" });
    expect(await prisma.lead.count()).toBe(2);
  });
});
