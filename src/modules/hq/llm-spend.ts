import { prisma } from "@/core/db";
import { llmDailyBudgetKop } from "@/core/llm/usage";
import { dayBounds, formatLocal } from "@/core/shared/time";

/**
 * Расходы на модели.
 *
 * Считает КОД прямым агрегатом по `LlmUsage`. Экран отвечает на два вопроса,
 * которые владелец задаёт в разном настроении: «сколько уходит» и «на что
 * именно уходит». Второй — важнее: суммарная цифра ничего не подсказывает, а
 * строка «скоринг кандидатов — 60% расхода» подсказывает сразу.
 */

export interface SpendByFeature {
  feature: string;
  costKop: number;
  calls: number;
  /** Доля от расхода за период, 0..1. */
  share: number;
}

export interface SpendDay {
  day: string;
  costKop: number;
}

export interface LlmSpendView {
  todayKop: number;
  budgetKop: number;
  /** Доля исчерпанного бюджета, 0..1. null — лимит не задан. */
  budgetUsed: number | null;
  monthKop: number;
  byFeature: SpendByFeature[];
  lastDays: SpendDay[];
  failures: Array<{ at: string; feature: string; gateway: string; error: string }>;
}

/** За сколько дней рисуем ряд. Две недели — видно и будни, и выходные. */
const DAYS = 14;

/** Сколько неудачных вызовов показываем: это разбор инцидента, не журнал. */
const FAILURES = 8;

export async function loadLlmSpend(now: Date = new Date()): Promise<LlmSpendView> {
  const today = dayBounds(now);
  const monthStart = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const seriesStart = new Date(now.getTime() - DAYS * 24 * 3600 * 1000);

  const [todayAgg, monthAgg, features, series, failures] = await Promise.all([
    prisma.llmUsage.aggregate({
      _sum: { costKop: true },
      where: { createdAt: { gte: today.start, lt: today.end } },
    }),
    prisma.llmUsage.aggregate({
      _sum: { costKop: true },
      where: { createdAt: { gte: monthStart } },
    }),
    prisma.llmUsage.groupBy({
      by: ["feature"],
      _sum: { costKop: true },
      _count: { _all: true },
      where: { createdAt: { gte: monthStart } },
      orderBy: { _sum: { costKop: "desc" } },
      take: 10,
    }),
    // Сутки режутся по поясу владельца, а не по UTC: иначе вечерний расход
    // уезжал бы в следующий день и ряд не сходился бы с дневной цифрой.
    prisma.$queryRaw<Array<{ day: string; cost: bigint }>>`
      SELECT to_char(("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${
        process.env.OWNER_TZ?.trim() || "Asia/Yekaterinburg"
      })::date, 'YYYY-MM-DD') AS day,
             SUM("costKop")::bigint AS cost
      FROM "LlmUsage"
      WHERE "createdAt" >= ${seriesStart}
      GROUP BY 1
      ORDER BY 1
    `,
    prisma.llmUsage.findMany({
      where: { ok: false, createdAt: { gte: monthStart } },
      orderBy: { createdAt: "desc" },
      take: FAILURES,
      select: { createdAt: true, feature: true, gateway: true, error: true },
    }),
  ]);

  const monthKop = monthAgg._sum.costKop ?? 0;
  const budgetKop = llmDailyBudgetKop();
  const todayKop = todayAgg._sum.costKop ?? 0;

  return {
    todayKop,
    budgetKop,
    budgetUsed: budgetKop > 0 ? todayKop / budgetKop : null,
    monthKop,
    byFeature: features.map((f) => ({
      feature: f.feature,
      costKop: f._sum.costKop ?? 0,
      calls: f._count._all,
      // Доля от суммы за тот же период — иначе проценты не сложатся в сто.
      share: monthKop > 0 ? (f._sum.costKop ?? 0) / monthKop : 0,
    })),
    lastDays: series.map((r) => ({ day: r.day, costKop: Number(r.cost) })),
    failures: failures.map((f) => ({
      at: formatLocal(f.createdAt),
      feature: f.feature,
      gateway: f.gateway,
      error: f.error ?? "без описания",
    })),
  };
}
