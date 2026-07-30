import { TZDate } from "@date-fns/tz";
import { assertKopInRange } from "@/core/shared/money";
import { OWNER_TZ } from "@/core/shared/time";

/**
 * Разбор значений из ячеек выписки: даты и суммы.
 *
 * Вынесено из парсеров банков, потому что форматы совпадают у всех российских
 * банков (`ДД.ММ.ГГГГ`, запятая как десятичный разделитель, неразрывные
 * пробелы в разрядах), а вот колонки у каждого свои.
 *
 * `parseAmountToKop` из `@/core/shared/money` здесь НЕ подходит: он написан для
 * речи владельца («3тр», «15к») и на «-3 500,00» потерял бы знак — он ищет
 * первое число и суффикс, а знак операции для выписки принципиален.
 */

/** Дата вида `01.07.2026` или `01.07.2026 14:23:05`. Время необязательно. */
export function parseStatementDate(raw: string): Date | null {
  const text = raw.trim();
  const match = /^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
  if (!match) return parseIsoDate(text);

  const [, dd, mm, yyyy, hh, mi, ss] = match;
  return buildMoscowDate(
    Number(yyyy),
    Number(mm),
    Number(dd),
    Number(hh ?? 0),
    Number(mi ?? 0),
    Number(ss ?? 0),
  );
}

/** Запасной формат — `2026-07-01` и `2026-07-01T14:23:00`. */
function parseIsoDate(text: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
  if (!match) return null;

  const [, yyyy, mm, dd, hh, mi, ss] = match;
  return buildMoscowDate(
    Number(yyyy),
    Number(mm),
    Number(dd),
    Number(hh ?? 0),
    Number(mi ?? 0),
    Number(ss ?? 0),
  );
}

/**
 * Дата из файла — местная для владельца, а не UTC.
 *
 * Банк печатает «01.07.2026 01:30» по московскому времени. Прочитать это как
 * UTC значит сдвинуть операцию на три часа назад — и операция первого числа
 * ночью уедет в предыдущий месяц, а месячный итог перестанет сходиться с
 * выпиской, ради сверки с которой всё и затевалось.
 */
function buildMoscowDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const local = new TZDate(year, month - 1, day, hour, minute, second, 0, OWNER_TZ);
  const date = new Date(local.getTime());
  if (Number.isNaN(date.getTime())) return null;

  // Переполнение вроде 31.02 date-fns тихо превратит в 3 марта. Для выписки
  // это означало бы операцию не в том месяце, поэтому проверяем обратным ходом.
  const check = new TZDate(date, OWNER_TZ);
  if (check.getDate() !== day || check.getMonth() !== month - 1) return null;

  return date;
}

export interface ParsedAmount {
  /** Всегда положительная. */
  amountKop: number;
  /** true — деньги ушли. */
  negative: boolean;
}

/**
 * Сумма из ячейки: `-3 500,00`, `+40000`, `1 200.50`, `−777` (минус U+2212).
 * Возвращает null, если в ячейке не число.
 */
export function parseStatementAmount(raw: string): ParsedAmount | null {
  const text = raw
    .replace(/ /g, " ")
    .replace(/[−–—]/g, "-") // типографские минусы из PDF-выгрузок и веб-таблиц
    .replace(/\s/g, "")
    .replace(/[^\d.,+-]/g, "") // символ валюты в ячейке — обычное дело
    .trim();
  if (text === "") return null;

  const negative = text.startsWith("-");
  const digits = text.replace(/^[+-]/, "");
  if (digits === "" || !/^[\d.,]+$/.test(digits)) return null;

  const normalized = normalizeDecimalSeparator(digits);
  const value = Number.parseFloat(normalized);
  if (!Number.isFinite(value)) return null;

  // Округление до копейки: в файле встречается и три знака после запятой.
  const amountKop = Math.round(value * 100);
  if (amountKop === 0) return null;

  try {
    assertKopInRange(amountKop);
  } catch {
    // Молча переполнить Int32 хуже, чем отвергнуть строку: переполнение
    // всплывёт месяцем позже как необъяснимо отрицательный оборот.
    return null;
  }

  return { amountKop: Math.abs(amountKop), negative };
}

/**
 * `1 234,56` и `1,234.56` — один и тот же формат в разных традициях.
 * Разделителем дробной части считаем ПОСЛЕДНИЙ знак, если после него меньше
 * трёх цифр; иначе это разделитель разрядов.
 */
function normalizeDecimalSeparator(digits: string): string {
  const lastComma = digits.lastIndexOf(",");
  const lastDot = digits.lastIndexOf(".");
  const last = Math.max(lastComma, lastDot);
  if (last === -1) return digits;

  const tail = digits.length - last - 1;
  if (tail === 3) return digits.replace(/[.,]/g, ""); // 1.234 / 1,234 — тысячи

  const intPart = digits.slice(0, last).replace(/[.,]/g, "");
  const fracPart = digits.slice(last + 1);
  return `${intPart}.${fracPart}`;
}
