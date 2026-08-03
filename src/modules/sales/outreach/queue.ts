import type { OutreachChannel, OutreachStatus } from "@prisma/client";
import { prisma } from "@/core/db";
import { dayBounds } from "@/core/shared/time";
import { formatPhone } from "../phone";
import { deepLink } from "./actions";
import { DAILY_DRAFT_CAP } from "./drafts";

/** Очередь черновиков для экрана аутрича. */

export interface DraftRow {
  id: string;
  leadId: string;
  leadName: string;
  city: string | null;
  channel: OutreachChannel;
  status: OutreachStatus;
  /** Что показывать и копировать: правка владельца важнее оригинала. */
  body: string;
  /** Оригинал модели — виден, только если владелец правил. */
  originalBody: string | null;
  reasoning: string | null;
  /** Ссылка, открывающая переписку. null — писать некуда. */
  link: string | null;
  phone: string | null;
  aiScore: number | null;
  createdAt: string;
}

export interface OutreachQueue {
  drafts: DraftRow[];
  /** Сколько черновиков составлено сегодня и сколько всего можно. */
  madeToday: number;
  dailyCap: number;
  sentToday: number;
}

export async function loadOutreachQueue(now: Date = new Date()): Promise<OutreachQueue> {
  const today = dayBounds(now);

  const [rows, madeToday, sentToday] = await Promise.all([
    prisma.outreachDraft.findMany({
      where: { status: { in: ["PENDING", "APPROVED"] } },
      orderBy: [{ status: "desc" }, { createdAt: "asc" }],
      take: 50,
      select: {
        id: true,
        leadId: true,
        channel: true,
        status: true,
        body: true,
        editedBody: true,
        reasoning: true,
        createdAt: true,
        lead: {
          select: {
            name: true,
            city: true,
            aiScore: true,
            phoneNormalized: true,
            contacts: {
              select: { telegram: true, phone: true, email: true },
              take: 3,
            },
          },
        },
      },
    }),
    prisma.outreachDraft.count({ where: { createdAt: { gte: today.start, lt: today.end } } }),
    prisma.outreachDraft.count({ where: { sentAt: { gte: today.start, lt: today.end } } }),
  ]);

  return {
    madeToday,
    dailyCap: DAILY_DRAFT_CAP,
    sentToday,
    drafts: rows.map((r) => {
      const body = r.editedBody ?? r.body;
      const contact = {
        telegram: r.lead.contacts.find((c) => c.telegram)?.telegram ?? null,
        phone: r.lead.phoneNormalized ?? r.lead.contacts.find((c) => c.phone)?.phone ?? null,
        email: r.lead.contacts.find((c) => c.email)?.email ?? null,
      };

      return {
        id: r.id,
        leadId: r.leadId,
        leadName: r.lead.name,
        city: r.lead.city,
        channel: r.channel,
        status: r.status,
        body,
        originalBody: r.editedBody ? r.body : null,
        reasoning: r.reasoning,
        link: deepLink(r.channel, contact, body),
        phone: formatPhone(contact.phone) ?? contact.phone,
        aiScore: r.lead.aiScore,
        createdAt: r.createdAt.toISOString(),
      };
    }),
  };
}

/** Сколько черновиков ждёт разбора — для счётчика на экране продаж. */
export async function countPendingDrafts(): Promise<number> {
  return prisma.outreachDraft.count({ where: { status: { in: ["PENDING", "APPROVED"] } } });
}
