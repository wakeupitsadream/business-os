import { prisma } from "@/core/db";
import { logInfo, logWarn } from "@/core/observability/logger";
import { formatKop } from "@/core/shared/money";
import { buildCallbackData } from "@/core/telegram/callbacks";
import { ImportError, createAndParseBatch, type ImportStats } from "./batch";
import { commitBatch } from "./commit";
import { cancelBatch } from "./rollback";
import type { ClassifiedRow } from "./classify";

/**
 * Импорт выписки из чата.
 *
 * Веб-путь и чат делят один и тот же конвейер (`createAndParseBatch` →
 * `commitBatch`); здесь только разговорная обёртка. Логику разбора сюда не
 * переносим и через HTTP-роут не ходим: тот требует сессию, которой у бота нет.
 *
 * Главное свойство, которое обязано сохраниться: **суммы не приходят из чата**.
 * Кнопка передаёт только идентификатор партии — всё остальное берётся из
 * `parsedRows`, разобранных на сервере. Соблазн обратного здесь велик, потому
 * что модель уже «видела» предпросмотр и знает цифры, но тогда цифры в базе
 * начинают зависеть от того, что сочинила модель.
 */

/** Сколько строк показываем в предпросмотре. Остальное — счётчиками. */
const PREVIEW_ROWS = 8;

/**
 * Короткий префикс отпечатка в кнопке. Полный отпечаток — 64 символа, он не
 * влезает в 64 байта `callback_data` вместе с идентификатором партии, а
 * превышение лимита заставляет Telegram отвергнуть клавиатуру ЦЕЛИКОМ.
 * Восьми символов достаточно, чтобы кнопка не подошла к другому предпросмотру.
 */
const FINGERPRINT_PREFIX = 8;

export interface ChatImportPreview {
  batchId: string;
  text: string;
  buttons: Array<Array<{ text: string; callbackData: string }>>;
}

/**
 * Разбор присланного файла и текст предпросмотра.
 *
 * Счёт не спрашиваем: в чате нет селектора, а спрашивать до разбора — значит
 * задавать вопрос вслепую. Берём счёт по умолчанию, тот же, что подставляется
 * при записи расхода фразой, и называем его в ответе, чтобы ошибка была видна.
 */
export async function startChatImport(input: {
  fileName: string;
  bytes: Uint8Array;
}): Promise<ChatImportPreview> {
  const account = await prisma.account.findFirst({
    where: { isArchived: false },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { id: true, name: true },
  });
  if (!account) throw new ImportError("Не настроено ни одного счёта.", "state");

  const batch = await createAndParseBatch({
    fileName: input.fileName,
    bytes: input.bytes,
    accountId: account.id,
  });

  const stored = await prisma.importBatch.findUniqueOrThrow({
    where: { id: batch.id },
    select: { parsedRows: true },
  });
  const rows = (stored.parsedRows ?? []) as unknown as ClassifiedRow[];

  logInfo("finance.chat_import_parsed", {
    batchId: batch.id,
    total: batch.stats.total,
    fresh: batch.stats.fresh,
  });

  return {
    batchId: batch.id,
    text: previewText(batch.stats, rows, account.name, batch.status),
    buttons: [
      [
        {
          text: batch.stats.fresh > 0 ? `Импортировать ${batch.stats.fresh}` : "Импортировать",
          callbackData: buildCallbackData([
            "imp",
            "ok",
            batch.id,
            batch.stats.fingerprint.slice(0, FINGERPRINT_PREFIX),
          ]),
        },
        { text: "Отменить", callbackData: buildCallbackData(["imp", "no", batch.id]) },
      ],
    ],
  };
}

/**
 * Текст предпросмотра.
 *
 * Показывать всё нельзя — выписка на триста строк превратится в несколько
 * экранов, которые пролистают не читая. Но и молчать нельзя: дубли, повторы и
 * поступления с ЮKassa не переводят партию в NEEDS_REVIEW, то есть без явного
 * упоминания исчезнут из поля зрения совсем. Поэтому — счётчики обо всём и
 * несколько первых строк для узнавания файла.
 */
export function previewText(
  stats: ImportStats,
  rows: ClassifiedRow[],
  accountName: string,
  status: string,
): string {
  const lines: string[] = [];

  lines.push(`📄 ${stats.bankLabel} → счёт «${accountName}»`);
  lines.push("");
  lines.push(`Всего строк: ${stats.total}`);
  lines.push(`Новых операций: ${stats.fresh}`);

  if (stats.duplicates > 0) lines.push(`Уже импортированы раньше: ${stats.duplicates}`);
  if (stats.transfers > 0) lines.push(`Похожи на переводы между счетами: ${stats.transfers}`);
  if (stats.settlements > 0) {
    lines.push(`Поступления с ЮKassa: ${stats.settlements} — запишу переводом, не доходом`);
  }
  if (stats.pending > 0) lines.push(`В обработке у банка, пропускаю: ${stats.pending}`);
  if (stats.skipped.length > 0) lines.push(`Не удалось разобрать строк: ${stats.skipped.length}`);

  const repeats = rows.filter((r) => r.repeatNote).length;
  if (repeats > 0) {
    lines.push(`Полных повторов внутри файла: ${repeats} — запишу каждый отдельной операцией`);
  }

  lines.push("");
  lines.push(`Доходы: ${formatKop(stats.incomeKop)}`);
  lines.push(`Расходы: ${formatKop(stats.expenseKop)}`);

  if (stats.controlSum.status === "mismatch") {
    lines.push("");
    lines.push("⚠️ Итог в файле не сошёлся с посчитанным — проверьте перед импортом.");
  }
  if (status === "NEEDS_REVIEW") {
    lines.push("");
    lines.push("⚠️ Есть непрочитанные строки. Импорт запишет только разобранные.");
  }

  const sample = rows.filter((r) => r.rowClass !== "duplicate").slice(0, PREVIEW_ROWS);
  if (sample.length > 0) {
    lines.push("");
    for (const row of sample) {
      const sign = row.type === "EXPENSE" ? "−" : "+";
      const day = row.date.slice(8, 10) + "." + row.date.slice(5, 7);
      lines.push(`${day}  ${sign}${formatKop(row.amountKop)}  ${row.description.slice(0, 40)}`);
    }
    if (stats.total > sample.length) lines.push(`… и ещё ${stats.total - sample.length}`);
  }

  return lines.join("\n");
}

export interface ChatCommitResult {
  ok: boolean;
  message: string;
}

/**
 * Подтверждение из чата.
 *
 * Отпечаток сверяется по короткому префиксу: он доказывает, что кнопка от
 * этого предпросмотра, а не от вчерашнего сообщения выше по переписке.
 */
export async function confirmChatImport(
  batchId: string,
  fingerprintPrefix: string,
): Promise<ChatCommitResult> {
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    select: { status: true, stats: true },
  });
  if (!batch) return { ok: false, message: "Этот импорт уже не найти — пришлите файл заново." };

  const stats = batch.stats as unknown as ImportStats | null;
  const fingerprint = stats?.fingerprint;
  if (!fingerprint || !fingerprint.startsWith(fingerprintPrefix)) {
    logWarn("finance.chat_import_stale", { batchId });
    return { ok: false, message: "Этот предпросмотр устарел — пришлите файл заново." };
  }

  try {
    const result = await commitBatch({
      batchId,
      fingerprint,
      // Решений нет: в чате владелец подтверждает разбор целиком. Отказаться от
      // отдельных строк можно на веб-экране импорта — здесь такой разговор
      // растянулся бы на десятки сообщений.
      decisions: [],
      acknowledgeWarnings: batch.status === "NEEDS_REVIEW",
    });

    if (result.alreadyCommitted) {
      return { ok: true, message: "Этот файл уже импортирован." };
    }

    const parts = [`Готово. Записал операций: ${result.created}`];
    if (result.skippedAsDuplicate > 0) parts.push(`пропустил дублей: ${result.skippedAsDuplicate}`);
    if (result.merged > 0) parts.push(`свёл переводов: ${result.merged}`);
    return { ok: true, message: parts.join(", ") + "." };
  } catch (e) {
    if (e instanceof ImportError) return { ok: false, message: e.message };
    throw e;
  }
}

export async function cancelChatImport(batchId: string): Promise<string> {
  await cancelBatch(batchId).catch(() => undefined);
  return "Импорт отменён, ничего не записано.";
}
