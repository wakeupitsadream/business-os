import { prisma } from "@/core/db";
import { logWarn } from "@/core/observability/logger";
import { llmDailyBudgetKop, llmSpentTodayKop } from "@/core/llm/usage";
import { dayBounds, formatLocal } from "@/core/shared/time";
import { computeOverview as financeOverview } from "@/modules/finance/metrics";
import { computeOverview as salesOverview } from "@/modules/sales/metrics";

/**
 * Сводка всех отделов для главного экрана.
 *
 * Каждый блок собирается отдельно и в своём try. HQ нужен владельцу ровно
 * тогда, когда что-то сломалось, и экран, падающий целиком из-за одного
 * отказавшего запроса, в этот момент бесполезен. Блок, который не собрался,
 * показывается пустым и честно говорит об этом — не нулём, потому что ноль
 * читается как факт.
 */

export interface HqKpi {
  /** null — блок не собрался. Ноль и «не знаем» это разные вещи. */
  value: number | null;
  hint: string;
}

export interface HqFeedItem {
  id: string;
  module: string;
  title: string;
  at: string;
}

export interface HqAgentRun {
  id: string;
  agentKey: string;
  status: string;
  startedAt: string;
  error: string | null;
}

export interface HqOverview {
  revenueKop: HqKpi;
  activeDeals: HqKpi;
  tasksToday: HqKpi;
  llmSpendKop: HqKpi;
  /** Дневной лимит расхода на модели, копейки. 0 — лимита нет. */
  llmBudgetKop: number;
  feed: HqFeedItem[];
  runs: HqAgentRun[];
  /** Что именно не собралось — показывается владельцу как есть. */
  failed: string[];
}

/** Сколько событий в ленте. Больше десяти — это уже журнал, а не лента. */
const FEED_SIZE = 10;

/** Сколько прогонов агентов показываем. */
const RUNS_SIZE = 5;

export async function collectHqOverview(now: Date = new Date()): Promise<HqOverview> {
  const failed: string[] = [];

  const revenue: HqKpi = { value: null, hint: "не удалось посчитать" };
  const deals: HqKpi = { value: null, hint: "не удалось посчитать" };
  const tasks: HqKpi = { value: null, hint: "не удалось посчитать" };
  const spend: HqKpi = { value: null, hint: "не удалось посчитать" };
  let budgetKop = 0;
  let feed: HqFeedItem[] = [];
  let runs: HqAgentRun[] = [];

  try {
    const fin = await financeOverview(now);
    revenue.value = fin.current.incomeKop;
    revenue.hint =
      fin.revenueChangePct === null
        ? "за текущий месяц"
        : `${fin.revenueChangePct >= 0 ? "+" : ""}${Math.round(fin.revenueChangePct)}% к прошлому месяцу`;
  } catch (e) {
    failed.push("Финансы");
    logWarn("hq.finance_failed", { error: e instanceof Error ? e.message : String(e) });
  }

  try {
    const sales = await salesOverview(now);
    deals.value = sales.activeDeals;
    deals.hint =
      sales.weightedAmountKop > 0
        ? `взвешенный потенциал ${Math.round(sales.weightedAmountKop / 100_000) / 10} тыс ₽`
        : "в работе";
  } catch (e) {
    failed.push("Продажи");
    logWarn("hq.sales_failed", { error: e instanceof Error ? e.message : String(e) });
  }

  try {
    const { start, end } = dayBounds(now);
    const [today, overdue] = await Promise.all([
      prisma.task.count({
        where: { status: { in: ["TODO", "IN_PROGRESS"] }, dueAt: { gte: start, lt: end } },
      }),
      prisma.task.count({
        where: { status: { in: ["TODO", "IN_PROGRESS"] }, dueAt: { lt: start } },
      }),
    ]);
    tasks.value = today;
    tasks.hint = overdue > 0 ? `просрочено ещё ${overdue}` : "со сроком на сегодня";
  } catch (e) {
    failed.push("Задачи");
    logWarn("hq.tasks_failed", { error: e instanceof Error ? e.message : String(e) });
  }

  try {
    spend.value = await llmSpentTodayKop();
    budgetKop = llmDailyBudgetKop();
    spend.hint =
      budgetKop > 0
        ? `лимит ${Math.round(budgetKop / 100)} ₽ в сутки`
        : "дневной лимит не задан";
  } catch (e) {
    failed.push("Расходы на ИИ");
    logWarn("hq.llm_failed", { error: e instanceof Error ? e.message : String(e) });
  }

  try {
    const rows = await prisma.domainEvent.findMany({
      // Системные события — шум для владельца: они про то, как работает
      // машина, а не про то, как идут дела.
      where: { module: { not: "system" } },
      orderBy: { occurredAt: "desc" },
      take: FEED_SIZE,
      select: { id: true, module: true, title: true, occurredAt: true },
    });
    feed = rows.map((r) => ({
      id: r.id,
      module: r.module,
      title: r.title,
      at: formatLocal(r.occurredAt),
    }));
  } catch (e) {
    failed.push("Лента событий");
    logWarn("hq.feed_failed", { error: e instanceof Error ? e.message : String(e) });
  }

  try {
    const rows = await prisma.agentRun.findMany({
      orderBy: { startedAt: "desc" },
      take: RUNS_SIZE,
      select: { id: true, agentKey: true, status: true, startedAt: true, error: true },
    });
    runs = rows.map((r) => ({
      id: r.id,
      agentKey: r.agentKey,
      status: r.status,
      startedAt: formatLocal(r.startedAt),
      error: r.error,
    }));
  } catch (e) {
    failed.push("Прогоны агентов");
    logWarn("hq.runs_failed", { error: e instanceof Error ? e.message : String(e) });
  }

  return {
    revenueKop: revenue,
    activeDeals: deals,
    tasksToday: tasks,
    llmSpendKop: spend,
    llmBudgetKop: budgetKop,
    feed,
    runs,
    failed,
  };
}
