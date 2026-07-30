import { prisma } from "@/core/db";
import { monthBounds, periodKey } from "@/core/shared/time";
import { percentChange } from "@/core/shared/money";
import { sumByCategory, sumByType, type CategoryTotal } from "./query";
import { resolvePeriod, type Range } from "./period";

/**
 * Метрики — только код, ни одного обращения к модели.
 *
 * Цифра на экране должна совпадать с `SELECT SUM(...)` в базе. Модель может
 * прокомментировать метрику, но не посчитать её: она ошибается правдоподобно,
 * и владелец узнаёт об этом, когда сверяет отчёт с банком.
 */

export interface PeriodTotals {
  incomeKop: number;
  expenseKop: number;
  profitKop: number;
  count: number;
}

export interface MonthPoint {
  /** "2026-07" — ключ периода по московскому времени. */
  key: string;
  label: string;
  incomeKop: number;
  expenseKop: number;
  profitKop: number;
}

export interface AccountBalance {
  id: string;
  name: string;
  balanceKop: number;
}

export interface FinanceOverview {
  range: Range;
  current: PeriodTotals;
  previous: PeriodTotals;
  /** Изменение прибыли к прошлому месяцу в процентах; null при нулевой базе. */
  profitChangePct: number | null;
  revenueChangePct: number | null;
  expenseChangePct: number | null;
  balances: AccountBalance[];
  totalBalanceKop: number;
  /** Месяцев до нуля при текущем среднем расходе; null — деньги не убывают. */
  runwayMonths: number | null;
  series: MonthPoint[];
  topExpenses: CategoryTotal[];
  topIncome: CategoryTotal[];
}

/** Сколько месяцев показываем на графике и берём для среднего burn. */
const SERIES_MONTHS = 6;
const BURN_WINDOW_MONTHS = 3;

export async function computeOverview(now: Date = new Date()): Promise<FinanceOverview> {
  const range = resolvePeriod("month", now);
  const prevRange = resolvePeriod("prev_month", now);

  const [current, previous, balances, series, topExpenses, topIncome] = await Promise.all([
    totalsFor(range),
    totalsFor(prevRange),
    accountBalances(),
    monthlySeries(now, SERIES_MONTHS),
    sumByCategory({ range }, "EXPENSE", 6),
    sumByCategory({ range }, "INCOME", 4),
  ]);

  const totalBalanceKop = balances.reduce((acc, b) => acc + b.balanceKop, 0);

  return {
    range,
    current,
    previous,
    profitChangePct: percentChange(current.profitKop, previous.profitKop),
    revenueChangePct: percentChange(current.incomeKop, previous.incomeKop),
    expenseChangePct: percentChange(current.expenseKop, previous.expenseKop),
    balances,
    totalBalanceKop,
    // Текущий месяц в средний burn не берём: он неполный, и в первых числах
    // расход по нему близок к нулю — runway показал бы годы там, где их нет.
    runwayMonths: computeRunwayMonths(totalBalanceKop, series.slice(0, -1)),
    series,
    topExpenses,
    topIncome,
  };
}

export async function totalsFor(range: Range): Promise<PeriodTotals> {
  const { incomeKop, expenseKop, count } = await sumByType({ range });
  return { incomeKop, expenseKop, profitKop: incomeKop - expenseKop, count };
}

/**
 * Ряд по месяцам для графика. Считается отдельными запросами на месяц, а не
 * одной группировкой по date_trunc: группировка в UTC резала бы месяцы не там,
 * где их видит владелец, и первое число каждого месяца уезжало бы в соседний.
 */
export async function monthlySeries(now: Date, months: number): Promise<MonthPoint[]> {
  const starts: Date[] = [];
  let cursor = monthBounds(now).start;
  for (let i = 0; i < months; i += 1) {
    starts.unshift(cursor);
    cursor = monthBounds(new Date(cursor.getTime() - 1)).start;
  }

  return Promise.all(
    starts.map(async (start) => {
      const { start: s, end } = monthBounds(start);
      const totals = await sumByType({ range: { start: s, end, label: "" } });
      return {
        key: periodKey(s),
        label: shortMonthLabel(s),
        incomeKop: totals.incomeKop,
        expenseKop: totals.expenseKop,
        profitKop: totals.incomeKop - totals.expenseKop,
      };
    }),
  );
}

/**
 * Остатки по счетам.
 *
 * Перевод между своими счетами не доход и не расход, но на остаток влияет:
 * с одного счёта деньги ушли, на другой пришли. Забыть про это значит показать
 * остаток, которого нет.
 */
export async function accountBalances(): Promise<AccountBalance[]> {
  const accounts = await prisma.account.findMany({
    where: { isArchived: false },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { id: true, name: true, openingBalanceKop: true },
  });
  if (accounts.length === 0) return [];

  const [byAccount, transfersIn] = await Promise.all([
    prisma.transaction.groupBy({
      by: ["accountId", "type"],
      _sum: { amountKop: true },
    }),
    prisma.transaction.groupBy({
      by: ["transferAccountId"],
      where: { type: "TRANSFER", transferAccountId: { not: null } },
      _sum: { amountKop: true },
    }),
  ]);

  const incoming = new Map<string, number>();
  for (const row of transfersIn) {
    if (row.transferAccountId) incoming.set(row.transferAccountId, row._sum.amountKop ?? 0);
  }

  return accounts.map((account) => {
    let balance = account.openingBalanceKop + (incoming.get(account.id) ?? 0);
    for (const row of byAccount) {
      if (row.accountId !== account.id) continue;
      const sum = row._sum.amountKop ?? 0;
      if (row.type === "INCOME") balance += sum;
      else balance -= sum; // EXPENSE и TRANSFER одинаково уменьшают остаток
    }
    return { id: account.id, name: account.name, balanceKop: balance };
  });
}

/**
 * Сколько месяцев проживёт бизнес на текущем остатке.
 *
 * Считается по среднему ЧИСТОМУ расходу (расходы минус доходы) за последние
 * полные месяцы. Если в среднем деньги прибавляются — runway не определён, и
 * это честнее, чем нарисовать «∞»: доход может кончиться, а «∞» на экране
 * читается как гарантия.
 */
export function computeRunwayMonths(
  balanceKop: number,
  months: Pick<MonthPoint, "incomeKop" | "expenseKop">[],
  window = BURN_WINDOW_MONTHS,
): number | null {
  const recent = months.slice(-window);
  if (recent.length === 0) return null;

  const netBurn =
    recent.reduce((acc, m) => acc + (m.expenseKop - m.incomeKop), 0) / recent.length;
  if (netBurn <= 0) return null;
  if (balanceKop <= 0) return 0;

  return balanceKop / netBurn;
}

const SHORT_MONTHS = [
  "янв",
  "фев",
  "мар",
  "апр",
  "май",
  "июн",
  "июл",
  "авг",
  "сен",
  "окт",
  "ноя",
  "дек",
];

function shortMonthLabel(start: Date): string {
  const [, month] = periodKey(start).split("-");
  return SHORT_MONTHS[Number(month) - 1] ?? (month ?? "");
}
