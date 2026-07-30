/**
 * Контракт парсера выписки.
 *
 * Отдельный файл, потому что его реализуют независимые парсеры (Т-Банк,
 * позже Точка, Сбер), а пользуются им батч и предпросмотр. Общий тип в
 * одном из парсеров означал бы, что «главный» банк диктует форму остальным.
 */

/** Одна разобранная строка выписки. Ещё НЕ операция: счёт и категория позже. */
export interface StatementRow {
  /** Момент операции. Время может отсутствовать в файле — тогда местная полночь. */
  date: Date;
  /** ВСЕГДА положительная: направление задаёт `type`. */
  amountKop: number;
  type: "INCOME" | "EXPENSE";
  /** Назначение платежа или магазин — по нему подбирается категория. */
  description: string;
  counterparty?: string | null;
  /** Код категории продавца: 5541 — АЗС, 5812 — рестораны. */
  mcc?: number | null;
  /** Категория, проставленная самим банком: подсказка, не истина. */
  bankCategory?: string | null;
  /** Номер строки в файле — чтобы показать владельцу, где именно проблема. */
  lineNo: number;
}

/** Итоги из шапки выписки, если банк их вообще печатает. */
export interface DeclaredTotals {
  incomeKop?: number;
  expenseKop?: number;
}

export interface ParseResult {
  rows: StatementRow[];
  /**
   * null — в файле итогов НЕТ (так у CSV Т-Банка). Это не то же самое, что
   * «итоги нулевые», и не то же самое, что «сверка прошла»: сверять нечем.
   */
  declaredTotals: DeclaredTotals | null;
  /** Строки, которые парсер сознательно пропустил, с причиной. */
  skipped: Array<{ lineNo: number; reason: string }>;
  /**
   * Сколько операций «в обработке». Считаются отдельно от прочих пропусков:
   * это не проблема файла, а нормальное состояние — они придут следующей
   * выпиской, и владельцу стоит сказать об этом, а не пугать его словом
   * «пропущено».
   */
  pending: number;
}

export interface BankStatementParser {
  /** Идентификатор для `ImportBatch.bankHint`. */
  id: string;
  label: string;
  /** Опознаёт формат по нормализованным заголовкам первой строки. */
  matches(headers: string[]): boolean;
  parse(rows: string[][]): Promise<ParseResult> | ParseResult;
}

/**
 * Ошибка разбора, которую можно показать владельцу.
 *
 * Отличается от любого другого падения тем, что её текст написан для человека
 * и объясняет, что не так с ФАЙЛОМ. «Cannot read property of undefined» на
 * загрузке выписки не говорит владельцу ничего.
 */
export class StatementParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatementParseError";
  }
}
