/**
 * Деньги в системе — ВСЕГДА целые копейки (Int).
 *
 * Почему не Float: 0.1 + 0.2 !== 0.3, и на сотне операций месячный итог
 * начинает расходиться с банком. Почему не Decimal: одна валюта (RUB),
 * а Decimal тянет за собой сериализацию Prisma.Decimal через границу
 * сервер→клиент и ломает Server Components.
 *
 * Предел Int32 ≈ 21 474 836 ₽ на ОДНУ операцию. Для владельца достаточно,
 * но при импорте выписок сумму обязательно прогонять через assertKopInRange:
 * молча переполнить Int хуже, чем отклонить строку.
 */

export const MAX_KOP = 2_147_483_647;

/**
 * Разделитель разрядов — неразрывный пробел, как в русской типографике и в
 * Intl.NumberFormat("ru-RU"). Записан escape-последовательностью намеренно:
 * вставленный «живым» символом, он невидим в исходнике и в тестах, и
 * расхождение с обычным пробелом ловится только по непонятному
 * «expected '1 000 ₽' to be '1 000 ₽'».
 */
export const THOUSANDS_SEPARATOR = "\u00A0";

export class MoneyRangeError extends Error {
  constructor(kop: number) {
    super(`Сумма ${kop} копеек вне диапазона Int32 (максимум ${MAX_KOP})`);
    this.name = "MoneyRangeError";
  }
}

export function assertKopInRange(kop: number): number {
  if (!Number.isFinite(kop) || !Number.isInteger(kop)) {
    throw new MoneyRangeError(kop);
  }
  if (Math.abs(kop) > MAX_KOP) throw new MoneyRangeError(kop);
  return kop;
}

/** Рубли (возможно дробные) → копейки. Округление банковское до копейки. */
export function rublesToKop(rubles: number): number {
  if (!Number.isFinite(rubles)) throw new MoneyRangeError(rubles);
  return assertKopInRange(Math.round(rubles * 100));
}

export function kopToRubles(kop: number): number {
  return kop / 100;
}

/**
 * Разбор суммы из текста — то, что владелец диктует секретарю:
 * «3тр», «15к», «1 200,50», «полтора косаря» (последнее — за пределами
 * регулярки, это работа LLM; здесь только числовые формы).
 * Возвращает копейки либо null, если распознать не удалось.
 */
export function parseAmountToKop(input: string): number | null {
  const raw = input
    .toLowerCase()
    .replace(/\u00A0/g, " ")
    .trim();

  const match = raw.match(/(-?\d[\d\s]*(?:[.,]\d+)?)\s*(тыс\.?|тысяч[аи]?|т\.?р\.?|тр|к|k|млн|м)?/);
  if (!match?.[1]) return null;

  const numeric = Number.parseFloat(match[1].replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(numeric)) return null;

  const suffix = match[2];
  let multiplier = 1;
  if (suffix) {
    if (/^(млн|м)$/.test(suffix)) multiplier = 1_000_000;
    else multiplier = 1_000;
  }

  try {
    return rublesToKop(numeric * multiplier);
  } catch {
    return null;
  }
}

/**
 * Формат для UI: «128 540 ₽», «−2 340 ₽». Копейки показываем только когда
 * они ненулевые — в сводках по бизнесу они шум.
 */
export function formatKop(kop: number, opts?: { alwaysKopecks?: boolean; sign?: boolean }): string {
  const negative = kop < 0;
  const abs = Math.abs(kop);
  const rubles = Math.floor(abs / 100);
  const kopecks = abs % 100;

  const showKopecks = opts?.alwaysKopecks || kopecks !== 0;
  const body = showKopecks
    ? `${formatGroups(rubles)},${String(kopecks).padStart(2, "0")}`
    : formatGroups(rubles);

  const prefix = negative ? "−" : opts?.sign ? "+" : "";
  // Неразрывный пробел и перед знаком рубля: иначе «₽» отрывается на новую
  // строку в узких карточках KPI.
  return `${prefix}${body}${THOUSANDS_SEPARATOR}₽`;
}

function formatGroups(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, THOUSANDS_SEPARATOR);
}

/** Процент изменения period-over-period. null, когда база нулевая. */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}
