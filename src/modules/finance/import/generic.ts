import { llmChat } from "@/core/llm";
import { logInfo, logWarn } from "@/core/observability/logger";

import { StatementParseError, type ParseResult, type StatementRow } from "./types";
import { parseStatementAmount, parseStatementDate } from "./values";

/**
 * Разбор выписки незнакомого банка.
 *
 * Модель здесь делает ровно одно: сопоставляет колонки. Она НЕ видит ни одного
 * настоящего числа и не производит ни одного — все цифры в образцах заменены
 * девятками, форма сохранена, значение уничтожено. Это не обещание в
 * комментарии, а свойство конструкции: вернуть сумму из файла модель не может,
 * потому что не получала её.
 *
 * Всё остальное — разбор по полученной карте — делает код, и карта прежде
 * проверяется на настоящих строках файла: модель предлагает, код проверяет.
 */

/** Доля строк, которые обязаны разобраться, чтобы карте можно было верить. */
const DATE_THRESHOLD = 0.9;
const AMOUNT_THRESHOLD = 0.95;

const SAMPLE_ROWS = 3;

export interface ColumnMapping {
  date: number;
  description: number;
  amount?: number;
  amountIn?: number;
  amountOut?: number;
  mcc?: number;
  status?: number;
}

export async function mapUnknownStatement(table: string[][]): Promise<ParseResult> {
  const header = table[0] ?? [];
  if (header.length < 2) {
    throw new StatementParseError(
      "Формат выписки не распознан: в файле меньше двух колонок. Возможно, это не CSV.",
    );
  }

  const mapping = await askForMapping(header, table.slice(1, 1 + SAMPLE_ROWS));
  if (!mapping) {
    throw new StatementParseError(
      "Формат выписки не распознан. Сохрани выписку в CSV из Т-Банка или попробуй позже.",
    );
  }

  const verified = verifyMapping(mapping, table.slice(1));
  if (!verified) {
    throw new StatementParseError(
      "Колонки выписки определить не удалось: в предполагаемых колонках даты и суммы " +
        "оказались не даты и не суммы.",
    );
  }

  return parseByMapping(mapping, table);
}

/**
 * Маскирование образцов: каждая цифра становится девяткой.
 *
 * «-1 500,00» → «-9 999,99». Модель по-прежнему видит, что колонка похожа на
 * сумму с запятой в качестве дробного разделителя и минусом для расхода, —
 * ровно то, что нужно для сопоставления. Значения при этом в промпт не
 * попадают вовсе.
 */
export function maskDigits(value: string): string {
  return value.replace(/\d/g, "9").slice(0, 40);
}

async function askForMapping(
  header: string[],
  samples: string[][],
): Promise<ColumnMapping | null> {
  const columns = header.map((h, i) => `${i}: ${h || "(без заголовка)"}`).join("\n");
  const rows = samples
    .map((row, n) => `строка ${n + 1}: ${row.map(maskDigits).join(" | ")}`)
    .join("\n");

  try {
    const result = await llmChat({
      feature: "finance.import_mapping",
      preset: "cheap",
      maxTokens: 200,
      messages: [
        {
          role: "system",
          content: [
            "Ты сопоставляешь колонки банковской выписки. Верни СТРОГО JSON",
            "с номерами колонок (числа, отсчёт с нуля):",
            '{"date": 0, "description": 3, "amount": 2, "mcc": null, "status": null}',
            "",
            "Если сумма разнесена по двум колонкам (приход и расход отдельно),",
            'верни вместо "amount" пару: {"amountIn": 4, "amountOut": 5}.',
            "",
            "Обязательны date и description, а также либо amount, либо пара",
            "amountIn/amountOut. Ненайденные поля — null. Никаких пояснений.",
            "",
            "В образцах все цифры заменены девятками — это нормально, тебе нужна",
            "только форма значений.",
          ].join("\n"),
        },
        {
          role: "user",
          content: `Колонки:\n${columns}\n\nОбразцы строк:\n${rows}`,
        },
      ],
    });

    return parseMappingReply(result.text, header.length);
  } catch (e) {
    // Недоступная модель — не повод отдавать пятисотку: владельцу нужно
    // понятное «формат не распознан», а не стектрейс.
    logWarn("finance.import_mapping_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

export function parseMappingReply(raw: string, columnCount: number): ColumnMapping | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }

  const index = (key: string): number | undefined => {
    const value = parsed[key];
    if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
    // Индекс вне диапазона — выдумка модели. Принять его значит читать
    // несуществующую колонку и получить пустые строки вместо ошибки.
    if (value < 0 || value >= columnCount) return undefined;
    return value;
  };

  const date = index("date");
  const description = index("description");
  const amount = index("amount");
  const amountIn = index("amountIn");
  const amountOut = index("amountOut");

  if (date === undefined || description === undefined) return null;
  if (amount === undefined && (amountIn === undefined || amountOut === undefined)) return null;
  if (description === date || description === amount) return null;

  return {
    date,
    description,
    ...(amount !== undefined ? { amount } : {}),
    ...(amountIn !== undefined ? { amountIn } : {}),
    ...(amountOut !== undefined ? { amountOut } : {}),
    ...(index("mcc") !== undefined ? { mcc: index("mcc") } : {}),
    ...(index("status") !== undefined ? { status: index("status") } : {}),
  };
}

/**
 * Проверка карты на настоящих строках.
 *
 * Именно она делает ответ модели безопасным. Модель охотно назовёт колонкой
 * даты колонку описания — и разбор пойдёт, выдавая пустые строки. Требуем,
 * чтобы в предполагаемой колонке даты действительно были даты.
 */
export function verifyMapping(mapping: ColumnMapping, rows: string[][]): boolean {
  const sample = rows.filter((r) => r.some((c) => c !== "")).slice(0, 100);
  if (sample.length === 0) return false;

  const dates = sample.filter((r) => parseStatementDate(cell(r, mapping.date)) !== null).length;
  if (dates / sample.length < DATE_THRESHOLD) return false;

  const amounts = sample.filter((r) => readAmount(mapping, r) !== null).length;
  return amounts / sample.length >= AMOUNT_THRESHOLD;
}

function parseByMapping(mapping: ColumnMapping, table: string[][]): ParseResult {
  const rows: StatementRow[] = [];
  const skipped: ParseResult["skipped"] = [];

  for (let i = 1; i < table.length; i += 1) {
    const row = table[i];
    if (!row || row.every((c) => c === "")) continue;
    const lineNo = i + 1;

    const date = parseStatementDate(cell(row, mapping.date));
    if (!date) {
      skipped.push({ lineNo, reason: `не разобрана дата «${cell(row, mapping.date)}»` });
      continue;
    }

    const money = readAmount(mapping, row);
    if (!money) {
      skipped.push({ lineNo, reason: "не разобрана сумма" });
      continue;
    }

    const mccRaw = mapping.mcc === undefined ? "" : cell(row, mapping.mcc);

    rows.push({
      date,
      amountKop: money.amountKop,
      type: money.negative ? "EXPENSE" : "INCOME",
      description: cell(row, mapping.description) || "Операция по выписке",
      mcc: /^\d{3,4}$/.test(mccRaw) ? Number(mccRaw) : null,
      bankCategory: null,
      lineNo,
    });
  }

  logInfo("finance.import_generic_parsed", { rows: rows.length, skipped: skipped.length });
  // Итогов в незнакомом файле мы искать не умеем — и говорим об этом честно.
  return { rows, declaredTotals: null, skipped, pending: 0 };
}

function readAmount(
  mapping: ColumnMapping,
  row: string[],
): { amountKop: number; negative: boolean } | null {
  if (mapping.amount !== undefined) {
    return parseStatementAmount(cell(row, mapping.amount));
  }

  // Две колонки: приход и расход. Заполнена всегда одна из них.
  const incoming = mapping.amountIn === undefined ? null : parseStatementAmount(cell(row, mapping.amountIn));
  if (incoming) return { amountKop: incoming.amountKop, negative: false };

  const outgoing = mapping.amountOut === undefined ? null : parseStatementAmount(cell(row, mapping.amountOut));
  if (outgoing) return { amountKop: outgoing.amountKop, negative: true };

  return null;
}

function cell(row: string[], index: number): string {
  if (index < 0) return "";
  return row[index] ?? "";
}

