import { prisma } from "@/core/db";
import { dayBounds } from "@/core/shared/time";
import { YOOKASSA_ACCOUNT_ID } from "../accounts";
import { classifySettlement } from "../settlement";
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
   * Ключ дедупа для случая, когда строка пишется выводом эквайринга: она ляжет
   * на счёт ЮKassa, а ключ считается от счёта, на котором операция окажется.
   * Без этого повторный импорт пересекающегося периода искал бы ключ не на том
   * счёте и создавал бы вывод заново — каждый раз.
   */
  settlementDedupKey?: string;
  /** Пояснение к строке, похожей на вывод эквайринга. */
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
  const keyed = rows.map((row, index) => ({
    row,
    index,
    dedupKey: buildDedupKey({
      accountId: ctx.accountId,
      date: row.date,
      amountKop: row.amountKop,
      description: row.description,
      type: row.type,
    }),
    // Тот же ключ, но от счёта ЮKassa: строка вывода ляжет туда, и искать её
    // при повторном импорте надо там же.
    settlementDedupKey: buildDedupKey({
      accountId: YOOKASSA_ACCOUNT_ID,
      date: row.date,
      amountKop: row.amountKop,
      description: row.description,
      type: row.type,
    }),
  }));

  const [existingCounts, settlementCounts, yookassaLedger, candidates, expenseSets, incomeSets] =
    await Promise.all([
      loadExistingCounts(
        ctx.accountId,
        keyed.map((k) => k.dedupKey),
      ),
      loadExistingCounts(
        YOOKASSA_ACCOUNT_ID,
        keyed.map((k) => k.settlementDedupKey),
      ),
      loadYookassaLedger(ctx.accountId),
      loadTransferCandidates(rows, ctx.accountId),
      loadRuleSets("EXPENSE"),
      loadRuleSets("INCOME"),
    ]);

  /**
   * Сколько строк с этим ключом уже «израсходовано».
   *
   * Правило одно на оба случая — и на повторный импорт, и на две одинаковые
   * строки внутри файла: если операций с таким ключом в базе уже N, то дублями
   * считаются первые N строк файла с этим ключом, а всё сверх — новые строки.
   *
   * Раньше здесь стоял `Set` «ключ уже видели», и он схлопывал две законные
   * одинаковые операции одного дня в одну: вторая чашка кофе за 200 ₽ молча
   * не импортировалась. Счётчик отличается от множества ровно в этом месте.
   */
  const used = new Map<string, number>();
  const takenCounterparts = new Set<string>();
  /**
   * Сколько запаса уже разобрали строки этого файла. Две выплаты в одной
   * выписке не должны обе опереться на один и тот же остаток.
   */
  let spentInFileKop = 0;

  const classified: ClassifiedRow[] = keyed.map(({ row, index, dedupKey, settlementDedupKey }) => {
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
    };

    // Решение про вывод эквайринга принимается ДО дедупа: от него зависит, на
    // каком счёте строка окажется, а значит — каким ключом её искать.
    const settlement = classifySettlement({
      type: row.type,
      description: row.description,
      amountKop: row.amountKop,
      // Остаток НА ДАТУ СТРОКИ, а не на сегодня: см. loadYookassaLedger.
      availableKop: balanceAsOf(yookassaLedger, row.date) - spentInFileKop,
      statementAccountId: ctx.accountId,
      yookassaAccountId: YOOKASSA_ACCOUNT_ID,
    });
    const asSettlement = settlement.kind === "settlement";

    /**
     * Одна и та же строка выписки могла быть записана ДВУМЯ способами, и обе
     * записи означают «эта строка уже импортирована».
     *
     * Строка, похожая на вывод, ложится либо переводом на счёт ЮKassa (ключ от
     * acc_yookassa), либо доходом на счёт выписки (ключ от него) — если
     * владелец снял галочку или если выручки на счёте ЮKassa не хватило.
     * Способ записи мог быть один в прошлый импорт и другой в этот: остаток
     * счёта ЮKassa между импортами меняется, а галочку владелец ставит руками.
     *
     * Поэтому у такой строки проверяются ОБА ключа и их счётчики складываются.
     * Если смотреть только на «текущий» ключ, то повторная загрузка
     * пересекающегося периода находит пусто и пишет те же деньги второй раз —
     * ровно тот двойной учёт, ради которого всё это и делается.
     */
    const isSettlementCandidate = settlement.kind !== "no";
    const identity = isSettlementCandidate ? `candidate:${dedupKey}` : dedupKey;
    const alreadyStored = isSettlementCandidate
      ? (existingCounts.get(dedupKey) ?? 0) + (settlementCounts.get(settlementDedupKey) ?? 0)
      : (existingCounts.get(dedupKey) ?? 0);

    const alreadyUsed = used.get(identity) ?? 0;
    used.set(identity, alreadyUsed + 1);
    if (alreadyUsed < alreadyStored) {
      return { ...base, rowClass: "duplicate" };
    }

    if (asSettlement) {
      // Запас тратится только на строку, которая действительно записывается:
      // у дубля вывод уже учтён и остаток уменьшил он.
      spentInFileKop += row.amountKop;
      return {
        ...base,
        rowClass: "settlement",
        settlementDedupKey,
        categoryId: null,
        categoryName: null,
        categoryVia: null,
        settlementNote:
          "вывод эквайринга — эта выручка уже учтена на счёте «ЮKassa», поэтому строка " +
          "записывается переводом, а не доходом",
      };
    }
    if (settlement.kind === "uncovered") {
      // Текст похож на вывод, но подтверждённой выручки на счёте ЮKassa нет.
      // Значит, эта строка — единственная запись о деньгах, и превратить её в
      // перемещение означало бы обнулить выручку. Оставляем доходом и говорим
      // об этом вслух.
      return {
        ...base,
        settlementNote:
          "похоже на вывод эквайринга, но на счёте «ЮKassa» нет столько неучтённой выручки — " +
          "оставляю доходом; если синк ЮKassa ещё не настроен, так и должно быть",
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
 * Сколько операций с каждым ключом уже лежит в базе.
 *
 * Именно СКОЛЬКО, а не «есть ли»: ключ не уникален, и на файле из трёх
 * одинаковых строк при двух уже импортированных ответ «есть» дал бы три дубля
 * вместо двух — третья операция потерялась бы.
 */
async function loadExistingCounts(
  accountId: string,
  keys: string[],
): Promise<Map<string, number>> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return new Map();

  const rows = await prisma.transaction.groupBy({
    by: ["dedupKey"],
    where: { accountId, dedupKey: { in: unique } },
    _count: { _all: true },
  });

  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.dedupKey) counts.set(row.dedupKey, row._count._all);
  }
  return counts;
}

/** Движение по счёту ЮKassa: время и знаковая сумма. */
interface LedgerEntry {
  time: number;
  deltaKop: number;
}

/**
 * Движения по счёту ЮKassa — для ответа на вопрос «сколько выручки уже было
 * учтено К ЭТОМУ ДНЮ».
 *
 * Остатком счёта на «сейчас» пользоваться нельзя, и это не тонкость. Порядок
 * работ владельца (`docs/OWNER-CHECKLIST.md`) — сначала настроить синк, потом
 * импортировать выписку, а синк на холодном старте забирает 90 дней. Значит,
 * выписка за прошлый год содержит выплаты, чья выручка на счёте ЮKassa не
 * учтена и уже никогда не будет. Сегодняшний остаток их бы покрыл — и каждая
 * такая строка превратилась бы в перевод, стерев прошлогоднюю выручку и заодно
 * съев запас, которого потом не хватит настоящим выплатам этого месяца.
 *
 * Поэтому запас считается на дату строки: выводом может быть только та
 * выплата, под которую к её дню уже записана выручка.
 */
async function loadYookassaLedger(statementAccountId: string): Promise<LedgerEntry[]> {
  if (statementAccountId === YOOKASSA_ACCOUNT_ID) return [];

  const rows = await prisma.transaction.findMany({
    where: { accountId: YOOKASSA_ACCOUNT_ID, type: { in: ["INCOME", "EXPENSE", "TRANSFER"] } },
    select: { date: true, type: true, amountKop: true },
    orderBy: { date: "asc" },
  });

  return rows.map((r) => ({
    time: r.date.getTime(),
    // Доход прибавляет, комиссия и уже записанный вывод — вычитают.
    deltaKop: r.type === "INCOME" ? r.amountKop : -r.amountKop,
  }));
}

/**
 * Остаток счёта ЮKassa на конец указанного дня.
 *
 * Ноль (и минус) — нормальное состояние ненастроенной интеграции, и тогда ни
 * одна строка выводом не станет. Это осознанный выбор в пользу переучёта:
 * лишнюю выручку видно и с ней можно разобраться, пропавшую — нечем.
 */
function balanceAsOf(ledger: LedgerEntry[], at: Date): number {
  const until = dayBounds(at).end.getTime();
  let sum = 0;
  for (const entry of ledger) {
    if (entry.time >= until) break;
    sum += entry.deltaKop;
  }
  return sum;
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
