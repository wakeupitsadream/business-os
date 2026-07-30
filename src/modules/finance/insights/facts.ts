import { percentChange } from "@/core/shared/money";
import type { MonthPoint } from "../metrics";
import type { CategoryTotal } from "../query";

/**
 * Слой фактов: чистые функции над уже посчитанными агрегатами.
 *
 * Ни одного обращения к базе и ни одного к модели — только арифметика.
 * Отсюда берутся числа для карточек, и отсюда же берётся список того, на что
 * модели разрешено ссылаться. Факт, которого здесь нет, не может попасть в
 * карточку: это и есть защита от уверенно выдуманного наблюдения.
 */

export type FactKind =
  | "trend"
  | "anomaly"
  | "concentration"
  | "runway"
  | "acquiring"
  | "profit";

export interface Fact {
  /** Короткий идентификатор — по нему модель ссылается на факт. */
  id: string;
  kind: FactKind;
  /** Готовая формулировка для промпта: модель не должна пересчитывать. */
  text: string;
  /** Числа-основания. По ним интерфейс показывает «расчёт». */
  data: Record<string, number | string>;
  /** Насколько это стоит внимания: сортировка карточек. */
  weight: number;
}

/** Ниже этого порога изменение — шум, а не тренд. */
const TREND_MIN_PCT = 25;
/** И ниже этой суммы тоже: +80% на кофе не новость. */
const TREND_MIN_KOP = 3_000_00;

/**
 * Рост и падение по категориям месяц к месяцу.
 *
 * Проценты без абсолютных сумм врут: расход, выросший с 200 ₽ до 600 ₽, даёт
 * +200% и не значит ничего. Поэтому порог двойной.
 */
export function categoryTrends(
  current: CategoryTotal[],
  previous: CategoryTotal[],
): Fact[] {
  const before = new Map(previous.map((c) => [c.categoryId ?? "none", c.amountKop]));
  const facts: Fact[] = [];

  for (const row of current) {
    const key = row.categoryId ?? "none";
    const prev = before.get(key) ?? 0;
    const deltaKop = row.amountKop - prev;
    if (Math.abs(deltaKop) < TREND_MIN_KOP) continue;

    const pct = percentChange(row.amountKop, prev);
    if (pct === null) {
      // Появилось с нуля — это не «рост на бесконечность», а новая статья.
      facts.push({
        id: `trend:${key}`,
        kind: "trend",
        text: `Появилась новая статья расходов «${row.categoryName}»: ${rub(row.amountKop)} ₽ за месяц, в прошлом месяце её не было.`,
        data: { amountKop: row.amountKop, previousKop: 0, category: row.categoryName },
        weight: Math.abs(deltaKop),
      });
      continue;
    }
    if (Math.abs(pct) < TREND_MIN_PCT) continue;

    const direction = deltaKop > 0 ? "вырос" : "снизился";
    facts.push({
      id: `trend:${key}`,
      kind: "trend",
      text:
        `Расход по категории «${row.categoryName}» ${direction} на ${Math.abs(Math.round(pct))}%: ` +
        `${rub(prev)} ₽ → ${rub(row.amountKop)} ₽.`,
      data: {
        amountKop: row.amountKop,
        previousKop: prev,
        deltaKop,
        percent: Math.round(pct),
        category: row.categoryName,
      },
      weight: Math.abs(deltaKop),
    });
  }

  return facts;
}

/**
 * Аномально крупная операция: выше среднего плюс два стандартных отклонения.
 *
 * Считается по истории месяцев, а не по операциям внутри месяца: у владельца
 * их десятки, и внутримесячная выборка слишком мала, чтобы отклонение
 * что-то значило.
 */
export function expenseAnomaly(series: MonthPoint[]): Fact | null {
  if (series.length < 4) return null;

  const history = series.slice(0, -1).map((m) => m.expenseKop);
  const current = series[series.length - 1];
  if (!current) return null;

  const mean = history.reduce((a, b) => a + b, 0) / history.length;
  if (mean <= 0) return null;

  const variance = history.reduce((acc, v) => acc + (v - mean) ** 2, 0) / history.length;
  const sigma = Math.sqrt(variance);
  const threshold = mean + 2 * sigma;

  if (current.expenseKop <= threshold) return null;

  return {
    id: "anomaly:expense",
    kind: "anomaly",
    text:
      `Расходы месяца — ${rub(current.expenseKop)} ₽ при среднем ${rub(Math.round(mean))} ₽ ` +
      `за предыдущие ${history.length} мес. Это заметно выше обычного.`,
    data: {
      amountKop: current.expenseKop,
      meanKop: Math.round(mean),
      thresholdKop: Math.round(threshold),
      months: history.length,
    },
    weight: current.expenseKop - Math.round(mean),
  };
}

/** Концентрация: сколько съедают три крупнейшие категории. */
export function concentration(current: CategoryTotal[]): Fact | null {
  const total = current.reduce((a, c) => a + c.amountKop, 0);
  if (total <= 0 || current.length < 3) return null;

  const top = [...current].sort((a, b) => b.amountKop - a.amountKop).slice(0, 3);
  const topSum = top.reduce((a, c) => a + c.amountKop, 0);
  const share = Math.round((topSum / total) * 100);
  if (share < 60) return null;

  return {
    id: "concentration:top3",
    kind: "concentration",
    text:
      `Три категории дают ${share}% всех расходов: ` +
      top.map((c) => `${c.categoryName} (${rub(c.amountKop)} ₽)`).join(", ") + ".",
    data: { sharePercent: share, topSumKop: topSum, totalKop: total },
    weight: topSum,
  };
}

/** Изменение runway: сколько месяцев осталось и куда движется. */
export function runwayFact(months: number | null, previousMonths: number | null): Fact | null {
  if (months === null) return null;

  const trend =
    previousMonths === null
      ? ""
      : months < previousMonths - 0.5
        ? ` Месяц назад было ${previousMonths.toFixed(1)} — запас сокращается.`
        : months > previousMonths + 0.5
          ? ` Месяц назад было ${previousMonths.toFixed(1)} — запас растёт.`
          : "";

  return {
    id: "runway",
    kind: "runway",
    text: `При текущем расходе денег на счетах хватит на ${months.toFixed(1)} мес.${trend}`,
    data: { months: Number(months.toFixed(2)), previousMonths: previousMonths ?? -1 },
    // Чем меньше запас, тем важнее: полгода — не новость, полтора месяца — да.
    weight: months < 3 ? 1_000_000 : months < 6 ? 300_000 : 50_000,
  };
}

/** Эффективная ставка эквайринга — во что обходится приём платежей. */
export function acquiringRate(incomeKop: number, feeKop: number): Fact | null {
  if (incomeKop <= 0 || feeKop <= 0) return null;

  const rate = (feeKop / incomeKop) * 100;
  return {
    id: "acquiring:rate",
    kind: "acquiring",
    text:
      `Эквайринг обошёлся в ${rub(feeKop)} ₽ — ${rate.toFixed(1)}% от поступлений ` +
      `(${rub(incomeKop)} ₽).`,
    data: { feeKop, incomeKop, ratePercent: Number(rate.toFixed(2)) },
    weight: feeKop,
  };
}

/** Прибыль месяца и её направление. */
export function profitFact(
  currentProfitKop: number,
  previousProfitKop: number,
): Fact | null {
  if (currentProfitKop === 0 && previousProfitKop === 0) return null;

  const pct = percentChange(currentProfitKop, previousProfitKop);
  const sign = currentProfitKop >= 0 ? "прибыль" : "убыток";
  const change =
    pct === null ? "" : ` Изменение к прошлому месяцу: ${pct > 0 ? "+" : ""}${Math.round(pct)}%.`;

  return {
    id: "profit:month",
    kind: "profit",
    text: `За месяц ${sign} ${rub(Math.abs(currentProfitKop))} ₽.${change}`,
    data: {
      profitKop: currentProfitKop,
      previousProfitKop,
      percent: pct === null ? 0 : Math.round(pct),
    },
    // Убыток важнее прибыли: о нём стоит сказать в первую очередь.
    weight: currentProfitKop < 0 ? 900_000 : 100_000,
  };
}

/** Рубли из копеек для текста факта. Без разделителей: это вход для модели. */
function rub(kop: number): string {
  const rubles = kop / 100;
  return Number.isInteger(rubles) ? String(rubles) : rubles.toFixed(2);
}
