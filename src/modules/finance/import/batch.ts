import { createHash } from "node:crypto";
import type { ImportStatus, Prisma } from "@prisma/client";
import { prisma } from "@/core/db";
import { logInfo, logWarn } from "@/core/observability/logger";
import { parseCsv } from "./csv";
import { classifyRows, type ClassifiedRow } from "./classify";
import { decodeStatement, type StatementEncoding } from "./decode";
import { detectParser } from "./detect";
import { mapUnknownStatement } from "./generic";
import { StatementParseError, type ParseResult } from "./types";

/**
 * Жизненный цикл импорта: загрузка → разбор → предпросмотр → коммит.
 *
 * Разбор идёт синхронно в запросе. Очереди в системе нет и не планируется:
 * один контейнер, файл на пару тысяч строк разбирается за доли секунды, а
 * очередь была бы лишней движущейся частью ради задачи, которая её не требует.
 */

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ROWS = 5_000;

export interface ControlSum {
  status: "not_available" | "matched" | "mismatch";
  reason?: string;
  declaredKop?: number;
  computedKop?: number;
  deltaKop?: number;
}

export interface ImportStats {
  accountId: string;
  accountName: string;
  encoding: StatementEncoding;
  bank: string;
  bankLabel: string;
  total: number;
  fresh: number;
  duplicates: number;
  transfers: number;
  /** Поступления с ЮKassa: пишутся переводом, а не доходом. */
  settlements: number;
  pending: number;
  skipped: Array<{ lineNo: number; reason: string }>;
  incomeKop: number;
  expenseKop: number;
  controlSum: ControlSum;
  /**
   * Поле из комментария к схеме. `null` значит «сверять не с чем» — интерфейс
   * читает `controlSum`, где это состояние выражено явно и не путается с
   * «не сошлось».
   */
  controlSumOk: boolean | null;
  /** sha256 разобранных строк: защита предпросмотра от устаревания. */
  fingerprint: string;
  headerFingerprint: string;
  committed?: { created: number; merged: number; skippedAsDuplicate: number };
  /** Что изменил коммит в уже существующих операциях — для отката. */
  /**
   * Сведённые в перевод встречные операции — чтобы откат вернул их как было.
   *
   * `previousAccountId` необязателен: партии, подтверждённые до того, как
   * сведение начало переносить счёт, лежат в Json без него и обязаны читаться
   * дальше. Отсутствие поля означает «счёт не менялся».
   */
  transferMerges?: Array<{
    txId: string;
    previousType: string;
    previousAccountId?: string;
    previousTransferAccountId: string | null;
  }>;
}

export class ImportError extends Error {
  constructor(
    message: string,
    readonly code: "input" | "state" | "stale" | "conflict" = "input",
  ) {
    super(message);
    this.name = "ImportError";
  }
}

/**
 * Загрузка и разбор одним действием.
 *
 * Разделять их незачем: файл, который не разобрался, владельцу не нужен, а
 * лишнее состояние «загружен, но не разобран» — это ещё один способ застрять.
 * `rawFile` сохраняется до разбора, чтобы упавший разбор можно было повторить
 * после починки парсера, не прося файл заново.
 */
/**
 * Разобрать заново из сохранённого файла.
 *
 * Нужна после отката: он оставляет сырьё, но достать его из базы владельцу
 * нечем — rawFile не читает ни один экран. Без этой функции сохранение файла
 * было бы правкой, которой не видно.
 *
 * Создаётся НОВАЯ партия, а не воскрешается старая, и строки классифицируются
 * с нуля, а не берутся из сохранённого parsedRows. Это принципиально: в
 * сохранённых ключах уже зашит номер повторения, посчитанный против состояния
 * базы на момент СТАРОГО разбора. С тех пор база изменилась — как минимум тем
 * самым откатом, — и переиспользование старых ключей означало бы дедуп по
 * снимку, которого больше нет.
 */
export async function reparseBatch(
  sourceBatchId: string,
  accountIdOverride?: string,
): Promise<{ id: string; status: ImportStatus; stats: ImportStats }> {
  const source = await prisma.importBatch.findUnique({
    where: { id: sourceBatchId },
    select: { fileName: true, rawFile: true, stats: true },
  });
  if (!source) throw new ImportError("Импорт не найден.", "state");
  if (!source.rawFile) {
    throw new ImportError(
      "Файл выписки уже удалён ночной чисткой — загрузи его заново.",
      "state",
    );
  }

  const stats = source.stats as unknown as ImportStats | null;
  const accountId = accountIdOverride ?? stats?.accountId;
  if (!accountId) {
    // У партии, упавшей на разборе, статистики нет вовсе — счёт может назвать
    // только владелец.
    throw new ImportError("Не удалось определить счёт — выбери его вручную.", "input");
  }

  return createAndParseBatch({
    fileName: source.fileName,
    bytes: new Uint8Array(source.rawFile),
    accountId,
  });
}

export async function createAndParseBatch(input: {
  fileName: string;
  bytes: Uint8Array;
  accountId: string;
}): Promise<{ id: string; status: ImportStatus; stats: ImportStats }> {
  if (input.bytes.byteLength === 0) throw new ImportError("Файл пуст.");
  if (input.bytes.byteLength > MAX_FILE_BYTES) {
    throw new ImportError(`Файл больше ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} МБ.`);
  }

  const account = await prisma.account.findFirst({
    where: { id: input.accountId, isArchived: false },
    select: { id: true, name: true },
  });
  if (!account) throw new ImportError("Счёт не найден.");

  const batch = await prisma.importBatch.create({
    data: {
      fileName: input.fileName.slice(0, 200),
      format: "csv",
      status: "PARSING",
      rawFile: Buffer.from(input.bytes),
    },
    select: { id: true },
  });

  try {
    const result = await parseBytes(input.bytes, { accountId: account.id, accountName: account.name });

    await prisma.importBatch.update({
      where: { id: batch.id },
      data: {
        status: result.status,
        bankHint: result.stats.bank,
        parsedRows: result.rows as unknown as Prisma.InputJsonValue,
        stats: result.stats as unknown as Prisma.InputJsonValue,
        error: null,
      },
    });

    logInfo("finance.import_parsed", {
      batchId: batch.id,
      bank: result.stats.bank,
      total: result.stats.total,
      fresh: result.stats.fresh,
    });
    return { id: batch.id, status: result.status, stats: result.stats };
  } catch (e) {
    const message = e instanceof StatementParseError || e instanceof ImportError
      ? e.message
      : "Не удалось разобрать файл.";

    // Причина всегда пишется в батч: молчаливый FAILED заставляет владельца
    // гадать, что не так с его выпиской.
    await prisma.importBatch.update({
      where: { id: batch.id },
      data: { status: "FAILED", error: message },
    });

    if (!(e instanceof StatementParseError) && !(e instanceof ImportError)) {
      logWarn("finance.import_parse_failed", {
        batchId: batch.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    throw e instanceof StatementParseError || e instanceof ImportError
      ? e
      : new ImportError(message);
  }
}

interface ParsedBatch {
  status: ImportStatus;
  rows: ClassifiedRow[];
  stats: ImportStats;
}

async function parseBytes(
  bytes: Uint8Array,
  account: { accountId: string; accountName: string },
): Promise<ParsedBatch> {
  const decoded = decodeStatement(bytes);
  const table = parseCsv(decoded.text);

  if (table.length < 2) {
    throw new StatementParseError("В файле нет ни одной строки с операциями.");
  }
  if (table.length - 1 > MAX_ROWS) {
    throw new StatementParseError(
      `В файле ${table.length - 1} строк — больше ${MAX_ROWS}. Раздели выписку по месяцам.`,
    );
  }

  const detection = detectParser(table);
  let parsed: ParseResult;
  let bank: string;
  let bankLabel: string;

  if (detection.parser) {
    parsed = await detection.parser.parse(table);
    bank = detection.parser.id;
    bankLabel = detection.parser.label;
  } else {
    parsed = await mapUnknownStatement(table);
    bank = "unknown";
    bankLabel = "Неизвестный банк";
  }

  if (parsed.rows.length === 0) {
    throw new StatementParseError(
      "Ни одной операции разобрать не удалось. Проверь, что это выписка, а не другой файл.",
    );
  }

  const classified = await classifyRows(parsed.rows, { accountId: account.accountId });

  const incomeKop = sum(parsed.rows.filter((r) => r.type === "INCOME").map((r) => r.amountKop));
  const expenseKop = sum(parsed.rows.filter((r) => r.type === "EXPENSE").map((r) => r.amountKop));
  const controlSum = checkControlSum(parsed, { incomeKop, expenseKop });

  const stats: ImportStats = {
    accountId: account.accountId,
    accountName: account.accountName,
    encoding: decoded.encoding,
    bank,
    bankLabel,
    total: classified.counts.total,
    fresh: classified.counts.fresh,
    duplicates: classified.counts.duplicates,
    transfers: classified.counts.transfers,
    settlements: classified.counts.settlements,
    pending: parsed.pending,
    skipped: parsed.skipped.slice(0, 50),
    incomeKop,
    expenseKop,
    controlSum,
    controlSumOk: controlSum.status === "not_available" ? null : controlSum.status === "matched",
    fingerprint: fingerprintRows(classified.rows),
    headerFingerprint: hash((table[0] ?? []).join("|").toLowerCase()),
  };

  // Разошедшиеся итоги или непрочитанные строки — повод остановиться и
  // показать владельцу, а не импортировать молча.
  const needsReview = controlSum.status === "mismatch" || parsed.skipped.length > 0;

  return { status: needsReview ? "NEEDS_REVIEW" : "PREVIEW", rows: classified.rows, stats };
}

/**
 * Контрольная сверка.
 *
 * Три исхода, и «нечего сверять» — полноценный третий, а не разновидность
 * неудачи. У карточного CSV Т-Банка итоговой строки нет вовсе, и зелёная
 * галочка в этом случае означала бы проверку, которой не было.
 */
export function checkControlSum(
  parsed: ParseResult,
  computed: { incomeKop: number; expenseKop: number },
): ControlSum {
  const declared = parsed.declaredTotals;
  if (!declared) {
    return { status: "not_available", reason: "в файле нет итоговой строки" };
  }

  const declaredKop = (declared.incomeKop ?? 0) - (declared.expenseKop ?? 0);
  const computedKop = computed.incomeKop - computed.expenseKop;
  const deltaKop = computedKop - declaredKop;

  if (deltaKop === 0) return { status: "matched", declaredKop, computedKop };
  return { status: "mismatch", declaredKop, computedKop, deltaKop };
}

/**
 * Отпечаток разобранных строк.
 *
 * Нужен, чтобы вкладка, открытая вчера, не подтвердила импорт по строкам,
 * которых уже нет. Считается по тому, что влияет на деньги, — по суммам,
 * датам и ключам, а не по всему объекту целиком.
 */
export function fingerprintRows(rows: ClassifiedRow[]): string {
  const canonical = rows
    .map((r) => `${r.index}:${r.date}:${r.type}:${r.amountKop}:${r.dedupKey}:${r.rowClass}`)
    .join("\n");
  return hash(canonical);
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}
