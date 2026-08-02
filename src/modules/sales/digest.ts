import { prisma } from "@/core/db";
import { dayBounds, formatLocal } from "@/core/shared/time";
import { loadBoard } from "./metrics";

/**
 * Дайджест касаний для утреннего брифа.
 *
 * Воронка молчалива по своей природе: обещание «перезвоню в четверг» живёт в
 * базе, а не в голове, и без напоминания оно просто не случается. Поэтому в
 * бриф идут две вещи, которые сегодня требуют действия, — наступившие касания
 * и сделки, застрявшие дольше порога своей стадии.
 *
 * Считает всё КОД, как и остальные числа брифа. Модель получает готовый список
 * и только формулирует его.
 */

export interface DigestFollowUp {
  id: string;
  leadId: string;
  leadName: string;
  /** Срок в часовом поясе владельца. */
  at: string;
  note: string | null;
  /** Срок наступил вчера или раньше. */
  overdue: boolean;
}

export interface DigestStaleDeal {
  dealId: string;
  leadName: string;
  title: string;
  stage: string;
  daysInStage: number;
}

export interface TouchDigest {
  /** Наступившие касания, самые ранние первыми. Список урезан, см. `followUpsTotal`. */
  followUps: DigestFollowUp[];
  /** Сколько их всего — чтобы урезание списка не читалось как «больше нет». */
  followUpsTotal: number;
  overdueTotal: number;
  stale: DigestStaleDeal[];
  staleTotal: number;
  newLeadsYesterday: number;
  touchesYesterday: number;
}

/** Сколько строк каждого рода попадает в бриф: он должен читаться за минуту. */
const SHOW_FOLLOW_UPS = 10;
const SHOW_STALE = 5;

export function emptyTouchDigest(): TouchDigest {
  return {
    followUps: [],
    followUpsTotal: 0,
    overdueTotal: 0,
    stale: [],
    staleTotal: 0,
    newLeadsYesterday: 0,
    touchesYesterday: 0,
  };
}

export async function collectTouchDigest(now: Date = new Date()): Promise<TouchDigest> {
  const today = dayBounds(now);
  const yesterday = dayBounds(new Date(now.getTime() - 24 * 3600 * 1000));

  const [due, followUpsTotal, overdueTotal, newLeadsYesterday, touchesYesterday, board] =
    await Promise.all([
      // Просроченное и сегодняшнее — одним списком: для владельца это одна
      // стопка дел, а не два раздела. Признак `overdue` отличает их внутри.
      prisma.followUp.findMany({
        where: { status: "PENDING", dueAt: { lt: today.end } },
        orderBy: { dueAt: "asc" },
        take: SHOW_FOLLOW_UPS,
        select: {
          id: true,
          dueAt: true,
          note: true,
          lead: { select: { id: true, name: true } },
        },
      }),
      prisma.followUp.count({ where: { status: "PENDING", dueAt: { lt: today.end } } }),
      prisma.followUp.count({ where: { status: "PENDING", dueAt: { lt: today.start } } }),
      prisma.lead.count({ where: { createdAt: { gte: yesterday.start, lt: yesterday.end } } }),
      // Смены стадии не считаем касаниями: их пишет система при перетаскивании
      // карточки, и включать их значило бы отчитываться о работе с клиентом,
      // которой не было.
      prisma.touchPoint.count({
        where: {
          occurredAt: { gte: yesterday.start, lt: yesterday.end },
          kind: { not: "STAGE_CHANGE" },
        },
      }),
      loadBoard(now),
    ]);

  // Признак «застряла» живёт в `loadBoard` вместе с порогом стадии. Считать
  // его здесь второй раз значит завести второе определение застрявшей сделки,
  // и однажды они разойдутся.
  const stale = board
    .filter((stage) => !stage.isWon && !stage.isLost)
    .flatMap((stage) =>
      stage.deals
        .filter((deal) => deal.isStale)
        .map((deal) => ({
          dealId: deal.id,
          leadName: deal.leadName,
          title: deal.title,
          stage: stage.name,
          daysInStage: deal.daysInStage,
        })),
    )
    .sort((a, b) => b.daysInStage - a.daysInStage);

  return {
    followUps: due.map((f) => ({
      id: f.id,
      leadId: f.lead.id,
      leadName: f.lead.name,
      at: formatLocal(f.dueAt),
      note: f.note,
      overdue: f.dueAt.getTime() < today.start.getTime(),
    })),
    followUpsTotal,
    overdueTotal,
    stale: stale.slice(0, SHOW_STALE),
    staleTotal: stale.length,
    newLeadsYesterday,
    touchesYesterday,
  };
}
