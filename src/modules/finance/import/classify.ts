import { prisma } from "@/core/db";
import { dayBounds } from "@/core/shared/time";
import { buildDedupKey } from "../transactions";
import { phraseOccurs, stemAll } from "../text";
import { categorizeImportedRow, loadRuleSets, type CategoryRuleSet } from "./rules";
import type { StatementRow } from "./types";

/**
 * Классификация разобранных строк перед предпросмотром.
 *
 * Три вопроса на строку: не приезжала ли она уже (дубль), не является ли она
 * второй ногой перевода между своими счетами, и в какую категорию её отнести.
 * Всё считается ДО коммита и складывается в `ImportBatch.parsedRows`: внутри
 * транзакции записи не должно быть ни одного запроса на сторону.
 */

/** Слова, по которым перевод между своими счетами узнаётся в описании. */
const TRANSFER_HINTS = [
  "перевод",
  "пополнение",
  "с карты на карту",
  "между счетами",
  "собственные средства",
  "card2card",
];

export type RowClass = "new" | "duplicate" | "transfer" | "settlement";

/**
 * Счёт ЮKassa из сид-миграции. Здесь константой, а не импортом из `yookassa/`,
 * чтобы разбор выписки не зависел от модуля интеграции: выписку разбирают и
 * тогда, когда ЮKassa вовсе не настроена.
 */
const YOOKASSA_ACCOUNT_ID = "acc_yookassa";

/**
 * Слова, по которым узнаётся перевод собственных денег с ЮKassa на банковский
 * счёт. Тот же набор уже используется правилом категории «Комиссии и
 * эквайринг» в миграции 00000000000006.
 */
const SETTLEMENT = /ю\s?kassa|юкасса|юмани|ю\s?money|yookassa|yoomoney|юmoney/i;

export interface ClassifiedRow {
  index: number;
  lineNo: number;
  /** ISO — строки уезжают в Json и обратно, Date туда не переживает поездку. */
  date: string;
  amountKop: number;
  type: "INCOME" | "EXPENSE";
  description: string;
  mcc: number | null;
  dedupKey: string;
  rowClass: RowClass;
  categoryId: string | null;
  categoryName: string | null;
  categoryVia: string | null;
  /** Встречная операция, если строка похожа на ногу перевода. */
  counterpartId?: string | null;
  counterpartAccount?: string | null;
  /** high — в описании есть слово «перевод»; low — совпали только цифры. */
  transferConfidence?: "high" | "low";
  /** Почему перевод НЕ предложен, хотя пара нашлась. */
  transferNote?: string;
  /**
   * Строка повторяет предыдущую по всем полям и импортируется как отдельная
   * операция. Показывается владельцу: отличить две настоящие заправки от
   * дважды выгруженной банком строки система не может, а он может.
   */
  repeatNote?: string;
  /**
   * Строка похожа на перевод собственных денег с ЮKassa на банковский счёт.
   * Показывается владельцу словами и переключается галочкой.
   */
  settlementNote?: string;
}

export interface ClassifyResult {
  rows: ClassifiedRow[];
  counts: {
    total: number;
    fresh: number;
    duplicates: number;
    transfers: number;
    settlements: number;
  };
}

export async function classifyRows(
  rows: StatementRow[],
  ctx: { accountId: string },
): Promise<ClassifyResult> {
  // Одинаковые строки внутри файла нумеруются по порядку: две заправки по
  // 2000 ₽ за день — законная пара, и без номера вторая получила бы хэш первой
  // и была бы съедена как дубль. Номер считается по составу файла, поэтому
  // повторная загрузка того же файла даёт те же ключи и ноль новых строк.
  const seenSoFar = new Map<string, { count: number; firstLineNo: number }>();
  const keyed = rows.map((row, index) => {
    const fields = {
      accountId: ctx.accountId,
      date: row.date,
      amountKop: row.amountKop,
      description: row.description,
      type: row.type,
    };
    const base = buildDedupKey(fields);
    const seen = seenSoFar.get(base);
    const occurrence = seen?.count ?? 0;
    seenSoFar.set(base, {
      count: occurrence + 1,
      firstLineNo: seen?.firstLineNo ?? row.lineNo,
    });

    return {
      row,
      index,
      occurrence,
      firstLineNo: seen?.firstLineNo ?? row.lineNo,
      dedupKey: occurrence === 0 ? base : buildDedupKey({ ...fields, occurrence }),
    };
  });

  const [existingKeys, candidates, expenseSets, incomeSets, yooActive] = await Promise.all([
    loadExistingKeys(keyed.map((k) => k.dedupKey)),
    loadTransferCandidates(rows, ctx.accountId),
    loadRuleSets("EXPENSE"),
    loadRuleSets("INCOME"),
    yookassaHasActivity(ctx.accountId),
  ]);

  // Страховка от падения на уникальном индексе посреди транзакции: владелец
  // увидел бы пятисотку вместо объяснения. После нумерации повторов ключи
  // внутри файла не совпадают, так что сработать здесь может только совпадение
  // с уже лежащим в базе — но убирать страховку незачем, она бесплатная.
  const seenInFile = new Set<string>();
  const takenCounterparts = new Set<string>();

  const classified: ClassifiedRow[] = keyed.map(({ row, index, dedupKey, occurrence, firstLineNo }) => {
    const sets = row.type === "EXPENSE" ? expenseSets : incomeSets;
    const category = categorizeImportedRow(row, sets);

    const base: ClassifiedRow = {
      index,
      lineNo: row.lineNo,
      date: row.date.toISOString(),
      amountKop: row.amountKop,
      type: row.type,
      description: row.description,
      mcc: row.mcc ?? null,
      dedupKey,
      rowClass: "new",
      categoryId: category?.id ?? null,
      categoryName: category?.name ?? null,
      categoryVia: category?.via ?? null,
      // Повтор импортируется как отдельная операция, но владельцу об этом
      // говорим: отличить две настоящие заправки от дважды выгруженной банком
      // строки может только он.
      ...(occurrence > 0
        ? { repeatNote: `Повторяет строку ${firstLineNo} полностью — импортируется отдельной операцией` }
        : {}),
    };

    if (existingKeys.has(dedupKey) || seenInFile.has(dedupKey)) {
      return { ...base, rowClass: "duplicate" };
    }
    seenInFile.add(dedupKey);

    // Перевод собственных денег с ЮKassa на банковский счёт. Те же деньги уже
    // посчитаны поштучно платежами клиентов — записать поступление доходом
    // значит удвоить выручку за месяц. Встречной операции для сведения нет:
    // синк ЮKassa пишет только платежи и комиссии, а сумма перевода — это
    // много платежей минус комиссии, она не совпадёт ни с одной строкой.
    if (yooActive && row.type === "INCOME" && SETTLEMENT.test(row.description)) {
      return {
        ...base,
        rowClass: "settlement",
        settlementNote: "Похоже на перевод с ЮKassa — те же деньги уже учтены платежами",
      };
    }

    const transfer = findTransfer(row, candidates, takenCounterparts);
    if (transfer.kind === "found") {
      takenCounterparts.add(transfer.counterpart.id);
      return {
        ...base,
        rowClass: "transfer",
        counterpartId: transfer.counterpart.id,
        counterpartAccount: transfer.counterpart.accountName,
        transferConfidence: transfer.confidence,
      };
    }
    if (transfer.kind === "ambiguous") {
      return { ...base, transferNote: transfer.note };
    }
    return base;
  });

  return {
    rows: classified,
    counts: {
      total: classified.length,
      fresh: classified.filter((r) => r.rowClass === "new").length,
      duplicates: classified.filter((r) => r.rowClass === "duplicate").length,
      transfers: classified.filter((r) => r.rowClass === "transfer").length,
      settlements: classified.filter((r) => r.rowClass === "settlement").length,
    },
  };
}

/**
 * Писал ли синк ЮKassa платежи на самом деле.
 *
 * Условие, без которого правка опаснее болезни. Если платежей нет, поступление
 * «от ЮKassa» — это настоящий доход, единственная запись об этих деньгах, и
 * превратить его в перевод значит стереть выручку из учёта совсем. Если
 * платежи есть, те же деньги уже посчитаны поштучно, и вторая запись удваивает
 * выручку.
 *
 * Смотрим на состояние базы, а не на переменные окружения: ключи могут быть
 * заданы, а синк ещё ни разу не отработать.
 *
 * Разбор выписки САМОГО счёта ЮKassa (если владелец когда-нибудь заведёт по
 * нему выгрузку) не должен превращать строки в переводы сам в себя.
 */
async function yookassaHasActivity(statementAccountId: string): Promise<boolean> {
  if (statementAccountId === YOOKASSA_ACCOUNT_ID) return false;
  const any = await prisma.transaction.findFirst({
    where: { accountId: YOOKASSA_ACCOUNT_ID, type: "INCOME" },
    select: { id: true },
  });
  return any !== null;
}

/**
 * Ищем по ключу, НЕ ограничиваясь счётом выписки.
 *
 * Счёт входит в состав ключа (см. buildDedupKey), поэтому ключ строки счёта A
 * не может получиться ни у одной строки счёта B — искать шире безопасно.
 * А нужно это потому, что часть строк ложится в базу на ДРУГОЙ счёт: перевод
 * с ЮKassa пишется на счёт ЮKassa. С фильтром по счёту выписки повторный
 * импорт пересекающегося периода не нашёл бы такую операцию и создал её
 * заново.
 */
async function loadExistingKeys(keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();

  const rows = await prisma.transaction.findMany({
    where: { dedupKey: { in: keys } },
    select: { dedupKey: true },
  });
  return new Set(rows.map((r) => r.dedupKey).filter((k): k is string => k !== null));
}

export interface TransferCandidate {
  id: string;
  accountId: string;
  accountName: string;
  type: "INCOME" | "EXPENSE" | "TRANSFER";
  date: Date;
  amountKop: number;
  text: string;
}

/**
 * Кандидаты на встречную ногу перевода ищутся В БАЗЕ, а не в файле.
 *
 * Выписка — это всегда ОДИН счёт, и перевод между своими счетами попадает в
 * неё одной ногой. Вторая либо уже импортирована выпиской другого счёта, либо
 * её нет вовсе.
 */
async function loadTransferCandidates(
  rows: StatementRow[],
  accountId: string,
): Promise<TransferCandidate[]> {
  if (rows.length === 0) return [];

  const amounts = [...new Set(rows.map((r) => r.amountKop))];
  const times = rows.map((r) => r.date.getTime());
  const from = dayBounds(new Date(Math.min(...times) - DAY_MS)).start;
  const to = dayBounds(new Date(Math.max(...times) + DAY_MS)).end;

  const found = await prisma.transaction.findMany({
    where: {
      accountId: { not: accountId },
      type: { in: ["INCOME", "EXPENSE"] },
      date: { gte: from, lt: to },
      amountKop: { in: amounts },
    },
    select: {
      id: true,
      accountId: true,
      type: true,
      date: true,
      amountKop: true,
      note: true,
      counterparty: true,
      account: { select: { name: true } },
    },
  });

  return found.map((t) => ({
    id: t.id,
    accountId: t.accountId,
    accountName: t.account.name,
    type: t.type,
    date: t.date,
    amountKop: t.amountKop,
    text: `${t.counterparty ?? ""} ${t.note ?? ""}`,
  }));
}

const DAY_MS = 24 * 60 * 60 * 1000;

type TransferVerdict =
  | { kind: "none" }
  | { kind: "found"; counterpart: TransferCandidate; confidence: "high" | "low" }
  | { kind: "ambiguous"; note: string };

/**
 * Поиск встречной ноги.
 *
 * Главная защита — от ложного срабатывания: два одинаковых платежа подрядчику
 * выглядят ровно как перевод между своими счетами. Поэтому при двух и более
 * кандидатах не предлагается НИЧЕГО: потерять расход хуже, чем не угадать
 * перевод, а угадывание тут не проверяемо.
 */
export function findTransfer(
  row: StatementRow,
  candidates: TransferCandidate[],
  taken: Set<string>,
): TransferVerdict {
  const opposite = row.type === "EXPENSE" ? "INCOME" : "EXPENSE";
  const window = dayWindow(row.date);

  const matches = candidates.filter(
    (c) =>
      !taken.has(c.id) &&
      c.type === opposite &&
      c.amountKop === row.amountKop &&
      c.date >= window.from &&
      c.date < window.to,
  );

  if (matches.length === 0) return { kind: "none" };
  if (matches.length > 1) {
    return {
      kind: "ambiguous",
      note: `нашлось ${matches.length} похожих встречных операций — свести автоматически нельзя`,
    };
  }

  const counterpart = matches[0];
  if (!counterpart) return { kind: "none" };

  const text = `${row.description} ${counterpart.text}`;
  const stems = stemAll(text);
  const confidence = TRANSFER_HINTS.some((hint) => phraseOccurs(hint, stems)) ? "high" : "low";

  return { kind: "found", counterpart, confidence };
}

/** Окно ±1 день по МОСКОВСКИМ суткам, а не «минус 24 часа». */
function dayWindow(date: Date): { from: Date; to: Date } {
  return {
    from: dayBounds(new Date(date.getTime() - DAY_MS)).start,
    to: dayBounds(new Date(date.getTime() + DAY_MS)).end,
  };
}
