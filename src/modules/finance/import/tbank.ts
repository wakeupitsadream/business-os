import { normalizeHeader } from "./csv";
import { StatementParseError, type BankStatementParser, type ParseResult, type StatementRow } from "./types";
import { parseStatementAmount, parseStatementDate } from "./values";

/**
 * Парсер выписки Т-Банка. Детерминированный, без модели.
 *
 * Формат стабилен, а языковая модель на табличных данных ошибается там, где
 * ошибка дороже всего: путает знак операции и день с месяцем. Тратить вызов
 * модели на разбор таблицы — платить деньги за то, чтобы стало хуже.
 *
 * Колонки ищутся ПО ЗАГОЛОВКАМ, а не по позициям. Банк добавляет колонки между
 * релизами (кэшбэк, бонусы, инвесткопилка, округление), и парсер, считающий
 * сумму пятым полем, однажды начнёт молча читать кэшбэк вместо суммы.
 */

/** Синонимы заголовков. Первый совпавший выигрывает — порядок значим. */
const COLUMNS = {
  date: ["дата операции", "дата и время операции", "дата"],
  operationAmount: ["сумма операции"],
  operationCurrency: ["валюта операции"],
  paymentAmount: ["сумма платежа"],
  paymentCurrency: ["валюта платежа"],
  fallbackAmount: ["сумма"],
  description: ["описание", "назначение платежа", "описание операции", "контрагент"],
  category: ["категория"],
  mcc: ["mcc", "мсс"],
  status: ["статус"],
} as const;

/**
 * Неуспешные операции. Строки в выписке есть, но денег по ним не двигалось:
 * импортировать их значит завысить расход на все отклонённые попытки оплаты.
 */
const FAILED_STATUSES = new Set(["failed", "отказ", "отклонено", "неуспешно", "declined"]);

/**
 * Операции «в обработке». Импортировать их нельзя по другой причине: холд
 * меняет сумму при проведении, и проведённая версия придёт следующей выпиской
 * как отдельная строка — с другой суммой она не совпадёт с холдом по дедупу, и
 * расход посчитается дважды.
 */
const PENDING_STATUSES = new Set(["waiting", "в обработке", "hold", "pending"]);

const RUB = new Set(["RUB", "РУБ", "₽", "643", ""]);

export const tbankParser: BankStatementParser = {
  id: "tbank",
  label: "Т-Банк",

  matches(headers) {
    // Опознаём по паре заголовков. По одному нельзя: «дата операции» есть у
    // половины банков, и чужая выписка ушла бы в парсер Т-Банка.
    return headers.includes("дата операции") && headers.includes("сумма операции");
  },

  parse(rows) {
    return parseTbank(rows);
  },
};

export function parseTbank(rows: string[][]): ParseResult {
  const header = rows[0];
  if (!header) throw new StatementParseError("Файл пуст — в нём нет даже строки заголовков.");

  const headers = header.map(normalizeHeader);
  const index = {
    date: findColumn(headers, COLUMNS.date),
    operationAmount: findColumn(headers, COLUMNS.operationAmount),
    operationCurrency: findColumn(headers, COLUMNS.operationCurrency),
    paymentAmount: findColumn(headers, COLUMNS.paymentAmount),
    paymentCurrency: findColumn(headers, COLUMNS.paymentCurrency),
    fallbackAmount: findColumn(headers, COLUMNS.fallbackAmount),
    description: findColumn(headers, COLUMNS.description),
    category: findColumn(headers, COLUMNS.category),
    mcc: findColumn(headers, COLUMNS.mcc),
    status: findColumn(headers, COLUMNS.status),
  };

  const hasAmount =
    index.operationAmount !== -1 || index.paymentAmount !== -1 || index.fallbackAmount !== -1;

  const missing: string[] = [];
  if (index.date === -1) missing.push("дата операции");
  if (!hasAmount) missing.push("сумма операции");
  if (index.description === -1) missing.push("описание");
  if (missing.length > 0) {
    // Список найденных заголовков в тексте ошибки — не роскошь: без него
    // владелец видит «не тот формат» и не понимает, что именно не так.
    throw new StatementParseError(
      `В выписке не хватает обязательных колонок: ${missing.join(", ")}. ` +
        `Найдены такие: ${header.join(", ")}`,
    );
  }

  const parsed: StatementRow[] = [];
  const skipped: ParseResult["skipped"] = [];
  let pending = 0;

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.every((c) => c === "")) continue;
    const lineNo = i + 1;

    const status = cell(row, index.status).toLowerCase();
    if (FAILED_STATUSES.has(status)) {
      skipped.push({ lineNo, reason: `операция не прошла (${cell(row, index.status)})` });
      continue;
    }
    if (PENDING_STATUSES.has(status)) {
      pending += 1;
      skipped.push({ lineNo, reason: "операция в обработке — придёт следующей выпиской" });
      continue;
    }

    const money = pickRubleAmount(row, index);
    if (!money.ok) {
      skipped.push({ lineNo, reason: money.reason });
      continue;
    }

    const date = parseStatementDate(cell(row, index.date));
    if (!date) {
      skipped.push({ lineNo, reason: `не разобрана дата «${cell(row, index.date)}»` });
      continue;
    }

    const description = cell(row, index.description);
    const bankCategory = cell(row, index.category);
    const mccRaw = cell(row, index.mcc);

    parsed.push({
      date,
      amountKop: money.amountKop,
      type: money.negative ? "EXPENSE" : "INCOME",
      description: description || bankCategory || "Операция по выписке",
      mcc: /^\d{3,4}$/.test(mccRaw) ? Number(mccRaw) : null,
      bankCategory: bankCategory || null,
      lineNo,
    });
  }

  // У CSV Т-Банка нет строки итогов — сверять не с чем, и делать вид, что
  // сверка прошла, нельзя. Явный null отличает «нечем сверять» от «сошлось».
  return { rows: parsed, declaredTotals: null, skipped, pending };
}

type AmountPick =
  | { ok: true; amountKop: number; negative: boolean }
  | { ok: false; reason: string };

/**
 * Рублёвая сумма операции.
 *
 * У Т-Банка две пары колонок: сумма операции (в валюте покупки) и сумма
 * платежа (в валюте счёта). Для покупки за границей первая будет в долларах, а
 * со счёта ушли рубли — и в учёт должны попасть именно они. Взять доллары как
 * рубли значит занизить расход в семьдесят раз.
 */
function pickRubleAmount(row: string[], index: Record<string, number>): AmountPick {
  const candidates: Array<{ amount: number; currency: number }> = [
    { amount: index.paymentAmount ?? -1, currency: index.paymentCurrency ?? -1 },
    { amount: index.operationAmount ?? -1, currency: index.operationCurrency ?? -1 },
    { amount: index.fallbackAmount ?? -1, currency: -1 },
  ];

  let sawForeign = "";
  for (const candidate of candidates) {
    if (candidate.amount === -1) continue;

    const currency = cell(row, candidate.currency).toUpperCase();
    if (!RUB.has(currency)) {
      sawForeign = currency;
      continue;
    }

    const parsed = parseStatementAmount(cell(row, candidate.amount));
    if (parsed) return { ok: true, ...parsed };
  }

  if (sawForeign !== "") {
    return { ok: false, reason: `операция в валюте ${sawForeign}, рублёвой суммы в строке нет` };
  }
  const shown = cell(row, index.paymentAmount ?? -1) || cell(row, index.operationAmount ?? -1);
  return { ok: false, reason: `не разобрана сумма «${shown}»` };
}

function findColumn(headers: string[], variants: readonly string[]): number {
  for (const variant of variants) {
    const exact = headers.indexOf(variant);
    if (exact !== -1) return exact;
  }
  // Запасной проход по началу строки: «сумма операции в рублях» — тот же смысл.
  for (const variant of variants) {
    const partial = headers.findIndex((h) => h.startsWith(variant));
    if (partial !== -1) return partial;
  }
  return -1;
}

function cell(row: string[], index: number): string {
  if (index < 0) return "";
  return row[index] ?? "";
}
