import type { Prisma } from "@prisma/client";
import { prisma } from "@/core/db";
import { logInfo, logWarn } from "@/core/observability/logger";
import { periodKey } from "@/core/shared/time";
import { computeOverview } from "../metrics";
import { resolvePeriod } from "../period";
import { sumByCategory } from "../query";
import {
  acquiringRate,
  categoryTrends,
  concentration,
  expenseAnomaly,
  profitFact,
  runwayFact,
  type Fact,
} from "./facts";
import { phraseCards } from "./phrasing";

/**
 * Сборка инсайтов за период.
 *
 * Две ступени, и порядок принципиален. Сначала код считает факты и делает из
 * самых важных карточки БЕЗ модели — у превышения бюджета и аномального
 * расхода есть точная формулировка, и модель может только её испортить.
 * Затем, если осталось место, модель связывает оставшиеся факты в наблюдения.
 *
 * Дедуп по `Insight.dedupKey` (вид + период + предмет): одно наблюдение на
 * тему в период, иначе за месяц лента превращается в тридцать копий «расходы
 * на рекламу растут».
 */

/** Сколько карточек показываем за раз. Больше — это уже лента, а не выводы. */
const MAX_TOTAL = 5;

/**
 * Порог, ниже которого запас прочности стоит отдельной карточки.
 *
 * Пятнадцать месяцев запаса — не новость, а фон. Карточка про них занимает
 * место и приучает пролистывать наблюдения не читая, после чего в той же
 * ленте потеряется и «осталось полтора месяца».
 */
const RUNWAY_ALERT_MONTHS = 6;

export interface GenerateResult {
  periodKey: string;
  factsFound: number;
  created: number;
  skippedExisting: number;
  reason?: string;
}

export async function generateInsights(now: Date = new Date()): Promise<GenerateResult> {
  const key = periodKey(now);
  const facts = await collectFacts(now);

  if (facts.length === 0) {
    return { periodKey: key, factsFound: 0, created: 0, skippedExisting: 0, reason: "не о чем говорить" };
  }

  // Шаблонные карточки — из самых весомых фактов, без модели.
  const templated = facts
    .filter((f) => f.kind === "anomaly" || (f.kind === "runway" && isShortRunway(f)))
    .map((fact) => ({
      kind: fact.kind === "anomaly" ? ("ANOMALY" as const) : ("RECOMMENDATION" as const),
      severity: fact.kind === "anomaly" ? ("WARNING" as const) : ("INFO" as const),
      title: fact.kind === "anomaly" ? "Расходы выше обычного" : "Запас прочности тает",
      body: fact.text,
      factIds: [fact.id],
    }));

  const remaining = Math.max(0, MAX_TOTAL - templated.length);
  const phrased = remaining > 0 ? await phraseCards(facts) : [];

  const cards = [
    ...templated,
    ...phrased.slice(0, remaining).map((card) => ({
      kind: "TREND" as const,
      severity:
        card.severity === "warning"
          ? ("WARNING" as const)
          : card.severity === "opportunity"
            ? ("OPPORTUNITY" as const)
            : ("INFO" as const),
      title: card.title,
      body: card.body,
      factIds: card.factIds,
    })),
  ];

  const byId = new Map(facts.map((f) => [f.id, f]));
  let created = 0;
  let skippedExisting = 0;

  for (const card of cards) {
    const dedupKey = `${card.kind}|${key}|${card.factIds.slice().sort().join(",")}`;

    const existing = await prisma.insight.findUnique({ where: { dedupKey }, select: { id: true } });
    if (existing) {
      skippedExisting += 1;
      continue;
    }

    const cited = card.factIds.map((id) => byId.get(id)).filter((f): f is Fact => f !== undefined);

    try {
      await prisma.insight.create({
        data: {
          kind: card.kind,
          severity: card.severity,
          title: card.title,
          bodyMd: card.body,
          // Числа-основания сохраняются вместе с карточкой: по ним интерфейс
          // показывает расчёт, и по ним же видно, что карточка не выдумана.
          factsJson: {
            facts: cited.map((f) => ({ id: f.id, kind: f.kind, text: f.text, data: f.data })),
          } as unknown as Prisma.InputJsonValue,
          periodKey: key,
          dedupKey,
        },
      });
      created += 1;
    } catch (e) {
      logWarn("finance.insight_save_failed", {
        dedupKey,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  logInfo("finance.insights_generated", { periodKey: key, facts: facts.length, created });
  return { periodKey: key, factsFound: facts.length, created, skippedExisting };
}

/** Сбор всех фактов периода. Только запросы к базе и арифметика. */
export async function collectFacts(now: Date): Promise<Fact[]> {
  const overview = await computeOverview(now);
  const month = resolvePeriod("month", now);
  const prevMonth = resolvePeriod("prev_month", now);

  const [prevCategories, feeTotals] = await Promise.all([
    sumByCategory({ range: prevMonth }, "EXPENSE", 20),
    acquiringFeeTotals(month),
  ]);

  const facts: Fact[] = [
    ...categoryTrends(overview.topExpenses, prevCategories),
    expenseAnomaly(overview.series),
    concentration(overview.topExpenses),
    runwayFact(overview.runwayMonths, null),
    acquiringRate(overview.current.incomeKop, feeTotals),
    profitFact(overview.current.profitKop, overview.previous.profitKop),
  ].filter((f): f is Fact => f !== null);

  // Сортировка по весу: самое важное попадает в карточки, остальное остаётся
  // в фактах и не мозолит глаза.
  return facts.sort((a, b) => b.weight - a.weight).slice(0, 12);
}

/** Комиссия эквайринга за период — по операциям, записанным синком ЮKassa. */
async function acquiringFeeTotals(range: { start: Date; end: Date; label: string }): Promise<number> {
  const rows = await prisma.transaction.aggregate({
    where: {
      source: "YOOKASSA",
      type: "EXPENSE",
      date: { gte: range.start, lt: range.end },
    },
    _sum: { amountKop: true },
  });
  return rows._sum.amountKop ?? 0;
}

/** Запас, о котором стоит сказать отдельно. Остальное остаётся в фактах. */
function isShortRunway(fact: Fact): boolean {
  const months = fact.data.months;
  return typeof months === "number" && months < RUNWAY_ALERT_MONTHS;
}
