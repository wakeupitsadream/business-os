import type { LeadNiche, LeadSource, Prisma, TouchKind } from "@prisma/client";
import { prisma } from "@/core/db";
import { logInfo } from "@/core/observability/logger";
import { normalizePhone } from "./phone";
import { PipelineError } from "./pipeline";

/**
 * Лиды и касания — единственная точка записи.
 *
 * Здесь же живёт дедуп по телефону. Он не «на всякий случай»: лидоген приводит
 * один и тот же автосервис из Яндекса, из 2ГИС и из заявки на сайте под тремя
 * разными названиями, и без склейки владелец звонит одному человеку трижды —
 * что хуже, чем не позвонить вовсе.
 */

/** Первая стадия воронки. Совпадает с сид-миграцией `00000000000012`. */
export const FIRST_STAGE_ID = "stage_new";

export interface CreateLeadInput {
  name: string;
  niche?: LeadNiche;
  city?: string | null;
  source?: LeadSource;
  phone?: string | null;
  site?: string | null;
  address?: string | null;
  note?: string | null;
  contact?: {
    name?: string | null;
    role?: string | null;
    phone?: string | null;
    email?: string | null;
    telegram?: string | null;
    isPersonalData?: boolean;
  };
}

export interface CreateLeadResult {
  leadId: string;
  /** true — лид уже был, склеили по телефону и дописали недостающее. */
  merged: boolean;
}

/**
 * Создать лида или подклеить к существующему.
 *
 * При совпадении телефона НИЧЕГО не перезаписывается: заполняются только
 * пустые поля. Свежий источник не обязательно точнее — у справочника может
 * быть старый адрес, а владелец мог поправить название руками. Затирать его
 * автоматикой значит терять правку молча.
 */
export async function createLead(input: CreateLeadInput): Promise<CreateLeadResult> {
  const name = input.name.trim();
  if (name.length === 0) throw new PipelineError("У лида должно быть название.", "input");

  const phoneNormalized = normalizePhone(input.phone);

  const existing = phoneNormalized
    ? await prisma.lead.findUnique({ where: { phoneNormalized }, select: { id: true } })
    : null;

  if (existing) {
    // Дописываем только пустое — см. шапку функции.
    await prisma.lead.update({
      where: { id: existing.id },
      data: {
        city: input.city?.trim() || undefined,
        site: input.site?.trim() || undefined,
        address: input.address?.trim() || undefined,
      },
    });
    if (input.contact) await addContact(existing.id, input.contact);

    logInfo("sales.lead_merged", { leadId: existing.id, phoneNormalized });
    return { leadId: existing.id, merged: true };
  }

  const lead = await prisma.lead.create({
    data: {
      name,
      niche: input.niche ?? "AUTO_SERVICE",
      city: input.city?.trim() || null,
      source: input.source ?? "MANUAL",
      phoneNormalized,
      site: input.site?.trim() || null,
      address: input.address?.trim() || null,
      note: input.note?.trim() || null,
      contacts: input.contact
        ? {
            create: {
              name: input.contact.name?.trim() || null,
              role: input.contact.role?.trim() || null,
              phone: input.contact.phone?.trim() || null,
              email: input.contact.email?.trim() || null,
              telegram: input.contact.telegram?.trim() || null,
              isPersonalData: input.contact.isPersonalData ?? false,
            },
          }
        : undefined,
    },
    select: { id: true },
  });

  logInfo("sales.lead_created", { leadId: lead.id, source: input.source ?? "MANUAL" });
  return { leadId: lead.id, merged: false };
}

async function addContact(leadId: string, contact: NonNullable<CreateLeadInput["contact"]>) {
  const phone = contact.phone?.trim() || null;
  const email = contact.email?.trim() || null;
  if (!phone && !email && !contact.name?.trim()) return;

  // Тот же контакт из второго источника — не новый контакт.
  const duplicate = await prisma.contact.findFirst({
    where: {
      leadId,
      OR: [...(phone ? [{ phone }] : []), ...(email ? [{ email }] : [])],
    },
    select: { id: true },
  });
  if (duplicate) return;

  await prisma.contact.create({
    data: {
      leadId,
      name: contact.name?.trim() || null,
      role: contact.role?.trim() || null,
      phone,
      email,
      telegram: contact.telegram?.trim() || null,
      isPersonalData: contact.isPersonalData ?? false,
    },
  });
}

/** Новая сделка по лиду — всегда с первой стадии воронки. */
export async function createDeal(input: {
  leadId: string;
  title?: string;
  amountMonthlyKop?: number;
}): Promise<{ dealId: string }> {
  const lead = await prisma.lead.findUnique({
    where: { id: input.leadId },
    select: { id: true, name: true },
  });
  if (!lead) throw new PipelineError("Лид не найден.", "not_found");

  const amountMonthlyKop = input.amountMonthlyKop ?? 0;
  if (!Number.isInteger(amountMonthlyKop) || amountMonthlyKop < 0) {
    // Деньги — целые копейки во всей системе, включая потенциальный MRR.
    throw new PipelineError("Сумма должна быть целым числом копеек.", "input");
  }

  const deal = await prisma.deal.create({
    data: {
      leadId: lead.id,
      title: input.title?.trim() || `Agentus для «${lead.name}»`,
      stageId: FIRST_STAGE_ID,
      amountMonthlyKop,
    },
    select: { id: true },
  });

  logInfo("sales.deal_created", { dealId: deal.id, leadId: lead.id });
  return { dealId: deal.id };
}

/** Касание руками: звонок, сообщение, заметка. */
export async function addTouchPoint(input: {
  leadId: string;
  dealId?: string | null;
  kind: TouchKind;
  body?: string | null;
  meta?: Prisma.InputJsonValue;
}): Promise<{ touchPointId: string }> {
  if (input.kind === "STAGE_CHANGE") {
    // Смену стадии пишет только `moveDeal`, вместе с самой сменой. Иначе в
    // ленте появляются переходы, которых не было.
    throw new PipelineError("Смена стадии пишется движением сделки, а не вручную.", "input");
  }

  await assertDealBelongsToLead(input.dealId, input.leadId);

  const touch = await prisma.touchPoint.create({
    data: {
      leadId: input.leadId,
      dealId: input.dealId ?? null,
      kind: input.kind,
      body: input.body?.trim() || null,
      meta: input.meta,
    },
    select: { id: true },
  });

  return { touchPointId: touch.id };
}

/**
 * Задача «коснуться лида к сроку».
 *
 * `Lead.nextFollowUpAt` денормализован специально: список лидов сортируется по
 * нему, и без этого поля каждая сортировка тянула бы за собой подзапрос по
 * всем незакрытым касаниям.
 */
export async function scheduleFollowUp(input: {
  leadId: string;
  dealId?: string | null;
  dueAt: Date;
  note?: string | null;
  origin?: "AUTO_RULE" | "AI_SUGGESTION" | "MANUAL";
}): Promise<{ followUpId: string }> {
  await assertDealBelongsToLead(input.dealId, input.leadId);

  const followUp = await prisma.$transaction(async (tx) => {
    const created = await tx.followUp.create({
      data: {
        leadId: input.leadId,
        dealId: input.dealId ?? null,
        dueAt: input.dueAt,
        note: input.note?.trim() || null,
        origin: input.origin ?? "MANUAL",
      },
      select: { id: true },
    });
    await refreshNextFollowUp(tx, input.leadId);
    return created;
  });

  return { followUpId: followUp.id };
}

export async function completeFollowUp(
  id: string,
  status: "DONE" | "SKIPPED" = "DONE",
): Promise<boolean> {
  const followUp = await prisma.followUp.findUnique({
    where: { id },
    select: { id: true, leadId: true, status: true },
  });
  if (!followUp || followUp.status !== "PENDING") return false;

  await prisma.$transaction(async (tx) => {
    await tx.followUp.update({
      where: { id },
      data: { status, completedAt: new Date() },
    });
    await refreshNextFollowUp(tx, followUp.leadId);
  });

  return true;
}

/**
 * Сделка и лид должны быть из одной пары.
 *
 * Внешние ключи по отдельности не спасают: и лид, и сделка существуют, просто
 * чужие друг другу. Такое касание попадёт в ленту одного лида, а числиться
 * будет за сделкой другого — и история обоих перестанет быть правдой.
 */
async function assertDealBelongsToLead(
  dealId: string | null | undefined,
  leadId: string,
): Promise<void> {
  if (!dealId) return;

  const deal = await prisma.deal.findUnique({ where: { id: dealId }, select: { leadId: true } });
  if (!deal) throw new PipelineError("Сделка не найдена.", "not_found");
  if (deal.leadId !== leadId) {
    throw new PipelineError("Эта сделка относится к другому лиду.", "input");
  }
}

/** Пересчёт денормализованного ближайшего касания. */
async function refreshNextFollowUp(tx: Prisma.TransactionClient, leadId: string): Promise<void> {
  const next = await tx.followUp.findFirst({
    where: { leadId, status: "PENDING" },
    orderBy: { dueAt: "asc" },
    select: { dueAt: true },
  });
  await tx.lead.update({
    where: { id: leadId },
    data: { nextFollowUpAt: next?.dueAt ?? null },
  });
}
