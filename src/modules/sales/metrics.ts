import { prisma } from "@/core/db";
import { dayBounds } from "@/core/shared/time";

/**
 * Цифры воронки для экрана продаж.
 *
 * Всё считает КОД, как и в финансах: модель здесь не участвует ни одной
 * цифрой. Она нужна для формулировок в еженедельном разборе, а не для чисел
 * на карточках — число, которое придумала модель, невозможно перепроверить.
 */

export interface StageColumn {
  id: string;
  name: string;
  position: number;
  probability: number;
  staleAfterDays: number | null;
  isWon: boolean;
  isLost: boolean;
  deals: DealCard[];
  /** Сумма потенциального MRR по колонке, копейки. */
  totalKop: number;
}

export interface DealCard {
  id: string;
  title: string;
  leadId: string;
  leadName: string;
  city: string | null;
  amountMonthlyKop: number;
  enteredStageAt: string;
  /** Сколько полных дней сделка стоит на текущей стадии. */
  daysInStage: number;
  /** Дольше `staleAfterDays` без движения — карточка помечается. */
  isStale: boolean;
  nextFollowUpAt: string | null;
}

export interface SalesOverview {
  /** Активные — всё, кроме выигранных и проигранных. */
  activeDeals: number;
  activeAmountKop: number;
  /** Потенциал с поправкой на вероятность стадии: честнее «суммы по списку». */
  weightedAmountKop: number;
  /** Выигранные за последние 30 дней — то, что уже стало MRR. */
  wonAmountKop: number;
  newLeadsWeek: number;
  touchesToday: number;
  staleDeals: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function loadBoard(now: Date = new Date()): Promise<StageColumn[]> {
  const [stages, deals] = await Promise.all([
    prisma.pipelineStage.findMany({ orderBy: { position: "asc" } }),
    prisma.deal.findMany({
      orderBy: { enteredStageAt: "asc" },
      select: {
        id: true,
        title: true,
        stageId: true,
        amountMonthlyKop: true,
        enteredStageAt: true,
        lead: { select: { id: true, name: true, city: true, nextFollowUpAt: true } },
      },
    }),
  ]);

  const byStage = new Map<string, DealCard[]>();
  for (const stage of stages) byStage.set(stage.id, []);

  for (const deal of deals) {
    const stage = stages.find((s) => s.id === deal.stageId);
    const daysInStage = Math.floor((now.getTime() - deal.enteredStageAt.getTime()) / DAY_MS);
    byStage.get(deal.stageId)?.push({
      id: deal.id,
      title: deal.title,
      leadId: deal.lead.id,
      leadName: deal.lead.name,
      city: deal.lead.city,
      amountMonthlyKop: deal.amountMonthlyKop,
      enteredStageAt: deal.enteredStageAt.toISOString(),
      daysInStage,
      isStale: stage?.staleAfterDays != null && daysInStage >= stage.staleAfterDays,
      nextFollowUpAt: deal.lead.nextFollowUpAt?.toISOString() ?? null,
    });
  }

  return stages.map((stage) => {
    const cards = byStage.get(stage.id) ?? [];
    return {
      id: stage.id,
      name: stage.name,
      position: stage.position,
      probability: stage.probability,
      staleAfterDays: stage.staleAfterDays,
      isWon: stage.isWon,
      isLost: stage.isLost,
      deals: cards,
      totalKop: cards.reduce((sum, d) => sum + d.amountMonthlyKop, 0),
    };
  });
}

export async function computeOverview(now: Date = new Date()): Promise<SalesOverview> {
  const board = await loadBoard(now);
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  const monthAgo = new Date(now.getTime() - 30 * DAY_MS);
  const today = dayBounds(now);

  const [newLeadsWeek, touchesToday] = await Promise.all([
    prisma.lead.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.touchPoint.count({
      where: { occurredAt: { gte: today.start, lt: today.end } },
    }),
  ]);

  const active = board.filter((s) => !s.isWon && !s.isLost);
  const won = board.find((s) => s.isWon);

  // Выигранные считаем за 30 дней, а не за всё время: «MRR» из сделки
  // двухлетней давности — это не сегодняшние деньги, и складывать их с
  // потенциалом воронки было бы враньём.
  const wonAmountKop =
    won?.deals
      .filter((d) => new Date(d.enteredStageAt).getTime() >= monthAgo.getTime())
      .reduce((sum, d) => sum + d.amountMonthlyKop, 0) ?? 0;

  return {
    activeDeals: active.reduce((n, s) => n + s.deals.length, 0),
    activeAmountKop: active.reduce((sum, s) => sum + s.totalKop, 0),
    weightedAmountKop: active.reduce(
      (sum, s) => sum + Math.round((s.totalKop * s.probability) / 100),
      0,
    ),
    wonAmountKop,
    newLeadsWeek,
    touchesToday,
    staleDeals: active.reduce((n, s) => n + s.deals.filter((d) => d.isStale).length, 0),
  };
}
