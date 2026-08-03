import type { LeadNiche, LeadSource, LostReason, TouchKind } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/core/db";
import { formatPhone } from "./phone";

/**
 * Карточка лида — всё, что о нём известно, на одном экране.
 *
 * Канбан показывает сделку одной строкой; решение «звонить или списывать»
 * принимается не по ней, а по истории: сколько раз касались, что отвечали,
 * когда обещали вернуться. Без этой карточки владелец держит историю в голове
 * и на десятом лиде перестаёт.
 *
 * Оценка ИИ (`aiScore`) и предложение следующего шага (`aiNextStep`) читаются
 * терпимо к мусору: их пишет лидоген (PR-3.3), формат может измениться, и
 * карточка не должна падать из-за поля, которого она не понимает. Не разобрали
 * — не показали, но всё остальное показали.
 */

export interface LeadCardContact {
  id: string;
  name: string | null;
  role: string | null;
  phone: string | null;
  email: string | null;
  telegram: string | null;
  isPersonalData: boolean;
}

export interface LeadCardDeal {
  id: string;
  title: string;
  stageId: string;
  stageName: string;
  isWon: boolean;
  isLost: boolean;
  amountMonthlyKop: number;
  enteredStageAt: string;
  daysInStage: number;
  lostReason: LostReason | null;
}

export interface LeadCardTouch {
  id: string;
  kind: TouchKind;
  body: string | null;
  occurredAt: string;
  /** Для STAGE_CHANGE — куда переехала сделка, человеческими словами. */
  stageMove: { from: string; to: string } | null;
}

export interface LeadCardFollowUp {
  id: string;
  dueAt: string;
  note: string | null;
  origin: string;
  overdue: boolean;
}

export interface LeadCardNextStep {
  action: string;
  why: string | null;
  dueInDays: number | null;
}

export interface LeadCard {
  id: string;
  name: string;
  niche: LeadNiche;
  city: string | null;
  source: LeadSource;
  /** Для показа: +7 999 123-45-67. Сравнивать по нему нельзя. */
  phone: string | null;
  site: string | null;
  address: string | null;
  note: string | null;
  createdAt: string;
  aiScore: number | null;
  aiScoreReasons: string[];
  aiNextStep: LeadCardNextStep | null;
  contacts: LeadCardContact[];
  deals: LeadCardDeal[];
  followUps: LeadCardFollowUp[];
  touches: LeadCardTouch[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Сколько касаний показываем в ленте: дальше история интересна редко. */
const TOUCH_FEED_LIMIT = 40;

const NextStepShape = z.object({
  action: z.string().trim().min(1).max(400),
  why: z.string().trim().max(800).optional(),
  dueInDays: z.number().int().min(0).max(365).optional(),
});

const ScoreDataShape = z.object({
  reasons: z.array(z.string().trim().min(1).max(300)).max(10).optional(),
});

const StageMoveShape = z.object({
  fromStageName: z.string().min(1),
  toStageName: z.string().min(1),
});

export function parseNextStep(raw: unknown): LeadCardNextStep | null {
  const parsed = NextStepShape.safeParse(raw);
  if (!parsed.success) return null;
  return {
    action: parsed.data.action,
    why: parsed.data.why ?? null,
    dueInDays: parsed.data.dueInDays ?? null,
  };
}

export function parseScoreReasons(raw: unknown): string[] {
  const parsed = ScoreDataShape.safeParse(raw);
  return parsed.success ? (parsed.data.reasons ?? []) : [];
}

export async function loadLeadCard(leadId: string, now: Date = new Date()): Promise<LeadCard | null> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: {
      id: true,
      name: true,
      niche: true,
      city: true,
      source: true,
      phoneNormalized: true,
      site: true,
      address: true,
      note: true,
      createdAt: true,
      aiScore: true,
      aiScoreData: true,
      aiNextStep: true,
      contacts: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          role: true,
          phone: true,
          email: true,
          telegram: true,
          isPersonalData: true,
        },
      },
      deals: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          title: true,
          stageId: true,
          amountMonthlyKop: true,
          enteredStageAt: true,
          lostReason: true,
          stage: { select: { name: true, isWon: true, isLost: true } },
        },
      },
      followUps: {
        where: { status: "PENDING" },
        orderBy: { dueAt: "asc" },
        select: { id: true, dueAt: true, note: true, origin: true },
      },
      touchPoints: {
        orderBy: { occurredAt: "desc" },
        take: TOUCH_FEED_LIMIT,
        select: { id: true, kind: true, body: true, occurredAt: true, meta: true },
      },
    },
  });

  if (!lead) return null;

  return {
    id: lead.id,
    name: lead.name,
    niche: lead.niche,
    city: lead.city,
    source: lead.source,
    phone: formatPhone(lead.phoneNormalized),
    site: lead.site,
    address: lead.address,
    note: lead.note,
    createdAt: lead.createdAt.toISOString(),
    aiScore: lead.aiScore,
    aiScoreReasons: parseScoreReasons(lead.aiScoreData),
    aiNextStep: parseNextStep(lead.aiNextStep),
    contacts: lead.contacts,
    deals: lead.deals.map((deal) => ({
      id: deal.id,
      title: deal.title,
      stageId: deal.stageId,
      stageName: deal.stage.name,
      isWon: deal.stage.isWon,
      isLost: deal.stage.isLost,
      amountMonthlyKop: deal.amountMonthlyKop,
      enteredStageAt: deal.enteredStageAt.toISOString(),
      daysInStage: Math.floor((now.getTime() - deal.enteredStageAt.getTime()) / DAY_MS),
      lostReason: deal.lostReason,
    })),
    followUps: lead.followUps.map((f) => ({
      id: f.id,
      dueAt: f.dueAt.toISOString(),
      note: f.note,
      origin: f.origin,
      overdue: f.dueAt.getTime() < now.getTime(),
    })),
    touches: lead.touchPoints.map((t) => {
      const move = StageMoveShape.safeParse(t.meta);
      return {
        id: t.id,
        kind: t.kind,
        body: t.body,
        occurredAt: t.occurredAt.toISOString(),
        stageMove: move.success
          ? { from: move.data.fromStageName, to: move.data.toStageName }
          : null,
      };
    }),
  };
}
