import { z } from "zod";

/**
 * Схема ответа ЮKassa.
 *
 * Разбор через zod, а не «как придёт»: интеграция с чужим API — это ровно то
 * место, где формат меняется без предупреждения. Без схемы смена формата
 * выглядит как «синк отработал, платежей ноль» — то есть как тишина, а не как
 * ошибка, и обнаруживается через месяц по недостающей выручке.
 */

/** Сумма у ЮKassa — строка с двумя знаками: {"value": "1500.00", "currency": "RUB"}. */
const Amount = z.object({
  value: z.string(),
  currency: z.string(),
});

export const YooPayment = z.object({
  id: z.string(),
  status: z.string(),
  /** Сколько заплатил клиент. */
  amount: Amount,
  /**
   * Сколько получит магазин — уже за вычетом комиссии эквайринга.
   * Может отсутствовать: у нерасчитанных платежей его нет.
   */
  income_amount: Amount.optional(),
  description: z.string().optional(),
  created_at: z.string(),
  captured_at: z.string().optional(),
  paid: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type YooPayment = z.infer<typeof YooPayment>;

export const YooPaymentList = z.object({
  type: z.string().optional(),
  items: z.array(YooPayment),
  /** Курсор следующей страницы. Отсутствует — страница последняя. */
  next_cursor: z.string().optional(),
});

export type YooPaymentList = z.infer<typeof YooPaymentList>;

/**
 * Рубли ЮKassa → копейки.
 *
 * Строка, а не число, и это удача: `Number("1500.10") * 100` даёт
 * 150009.99999999999, и округление вниз потеряло бы копейку на каждом платеже.
 * Поэтому разбираем текстом — целая и дробная части отдельно.
 */
export function yooAmountToKop(value: string): number | null {
  const match = /^(-?)(\d+)(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;

  const [, sign, whole, frac = ""] = match;
  const kopecks = Number(`${whole}${frac.padEnd(2, "0")}`);
  if (!Number.isSafeInteger(kopecks)) return null;

  return sign === "-" ? -kopecks : kopecks;
}
