import type { OutreachChannel, TouchKind } from "@prisma/client";
import { prisma } from "@/core/db";
import { logInfo } from "@/core/observability/logger";
import { CONTACTED_STAGE_ID, FIRST_STAGE_ID, addTouchPoint, createDeal, scheduleFollowUp } from "../leads";
import { PipelineError, moveDeal } from "../pipeline";
import { FOLLOW_UP_DAYS } from "./drafts";

/**
 * Что владелец делает с черновиком.
 *
 * Единственное необратимое действие здесь — «отправлено», и оно НЕ отправляет:
 * владелец уже написал человеку руками, а система лишь записывает, что это
 * случилось. Отсюда и порядок: сначала касание и движение воронки, потом
 * отметка на черновике — если что-то упадёт посередине, лучше остаться с
 * записанным касанием и неотмеченным черновиком, чем наоборот.
 */

const TOUCH_KIND: Record<OutreachChannel, TouchKind> = {
  TELEGRAM: "MESSAGE_TG",
  WHATSAPP: "MESSAGE_WA",
  EMAIL: "EMAIL",
  PHONE: "CALL",
};

export async function approveDraft(id: string, editedBody?: string | null): Promise<boolean> {
  const body = editedBody?.trim();

  const updated = await prisma.outreachDraft.updateMany({
    where: { id, status: { in: ["PENDING", "APPROVED"] } },
    data: {
      status: "APPROVED",
      approvedAt: new Date(),
      // Правка сохраняется рядом с оригиналом, а не вместо него: это образец
      // тона для следующих черновиков и честный ответ на вопрос, насколько
      // модель попадает.
      ...(body ? { editedBody: body } : {}),
    },
  });

  return updated.count === 1;
}

export async function rejectDraft(id: string): Promise<boolean> {
  const updated = await prisma.outreachDraft.updateMany({
    where: { id, status: { in: ["PENDING", "APPROVED"] } },
    data: { status: "REJECTED" },
  });
  return updated.count === 1;
}

export interface MarkSentResult {
  dealId: string;
  /** true — сделка переехала в «связались»; false — она уже была дальше. */
  moved: boolean;
  followUpId: string;
}

/**
 * «Я это отправил».
 *
 * Здесь выполняется DoD аутрича: ручная отправка двигает воронку. Сделка
 * заводится, если её не было, и переезжает в «связались» — но только из
 * первой стадии: черновик, отправленный лиду, с которым уже идёт демо, не
 * должен откатывать его назад.
 */
export async function markSent(id: string, now: Date = new Date()): Promise<MarkSentResult> {
  const draft = await prisma.outreachDraft.findUnique({
    where: { id },
    select: {
      id: true,
      leadId: true,
      dealId: true,
      channel: true,
      body: true,
      editedBody: true,
      status: true,
      lead: { select: { name: true, deals: { select: { id: true, stageId: true }, take: 1 } } },
    },
  });

  if (!draft) throw new PipelineError("Черновик не найден.", "not_found");
  if (draft.status === "SENT" || draft.status === "REPLIED") {
    throw new PipelineError("Этот черновик уже отмечен отправленным.", "state");
  }
  if (draft.status === "REJECTED") {
    throw new PipelineError("Отклонённый черновик отправленным не отмечают.", "state");
  }

  const existing = draft.dealId
    ? { id: draft.dealId, stageId: null as string | null }
    : (draft.lead.deals[0] ?? null);

  const dealId = existing?.id ?? (await createDeal({ leadId: draft.leadId })).dealId;

  await addTouchPoint({
    leadId: draft.leadId,
    dealId,
    kind: TOUCH_KIND[draft.channel],
    body: draft.editedBody ?? draft.body,
  });

  // Стадию читаем заново: она могла измениться, пока черновик лежал в очереди.
  const deal = await prisma.deal.findUniqueOrThrow({
    where: { id: dealId },
    select: { stageId: true },
  });

  let moved = false;
  if (deal.stageId === FIRST_STAGE_ID) {
    const result = await moveDeal({
      dealId,
      toStageId: CONTACTED_STAGE_ID,
      note: `Аутрич отправлен вручную (${draft.channel.toLowerCase()})`,
    });
    moved = result.moved;
  }

  const { followUpId } = await scheduleFollowUp({
    leadId: draft.leadId,
    dealId,
    dueAt: new Date(now.getTime() + FOLLOW_UP_DAYS * 24 * 3600 * 1000),
    note: `Написали ${draft.lead.name} — ответа пока нет`,
    origin: "AUTO_RULE",
  });

  await prisma.outreachDraft.update({
    where: { id: draft.id },
    data: { status: "SENT", sentAt: now, dealId },
  });

  logInfo("sales.outreach_sent", { draftId: draft.id, dealId, moved });
  return { dealId, moved, followUpId };
}

/** Ответили. Дальше разговор живёт в касаниях, черновик своё отработал. */
export async function markReplied(id: string): Promise<boolean> {
  const updated = await prisma.outreachDraft.updateMany({
    where: { id, status: "SENT" },
    data: { status: "REPLIED", repliedAt: new Date() },
  });
  return updated.count === 1;
}

/**
 * Ссылка, открывающая переписку.
 *
 * Текст подставляется только в WhatsApp: у Telegram нет способа открыть чат с
 * заготовленным сообщением, поэтому там ссылка ведёт в диалог, а текст
 * владелец вставляет кнопкой «Скопировать». Делать вид, что подставится,
 * значило бы отправить пустое сообщение вместо письма.
 */
export function deepLink(
  channel: OutreachChannel,
  target: { telegram?: string | null; phone?: string | null; email?: string | null },
  body: string,
): string | null {
  if (channel === "TELEGRAM") {
    const handle = target.telegram?.trim().replace(/^@/, "");
    return handle ? `https://t.me/${encodeURIComponent(handle)}` : null;
  }

  if (channel === "WHATSAPP") {
    const digits = target.phone?.replace(/\D+/g, "");
    return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(body)}` : null;
  }

  if (channel === "EMAIL") {
    const email = target.email?.trim();
    return email ? `mailto:${email}?body=${encodeURIComponent(body)}` : null;
  }

  const digits = target.phone?.replace(/\D+/g, "");
  return digits ? `tel:+${digits}` : null;
}
