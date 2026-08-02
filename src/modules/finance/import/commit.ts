import type { Prisma } from "@prisma/client";
import { prisma } from "@/core/db";
import { logInfo } from "@/core/observability/logger";
import { YOOKASSA_ACCOUNT_ID } from "../accounts";
import { createTransaction } from "../transactions";
import { ImportError, fingerprintRows, type ImportStats } from "./batch";
import type { ClassifiedRow } from "./classify";

/**
 * Подтверждение импорта.
 *
 * Два свойства, ради которых этот файл существует отдельно.
 *
 * Первое: **суммы приходят с сервера, а не от клиента**. В теле запроса нет ни
 * сумм, ни дат, ни счёта — только «эту строку не надо» и «эту в такую-то
 * категорию». Всё остальное берётся из `parsedRows`, сохранённых при разборе.
 *
 * Второе: **партия ложится целиком или не ложится вовсе**. Половина импорта в
 * базе хуже, чем его отсутствие: владелец видит правдоподобные, но неполные
 * цифры и не знает, что их надо перепроверить.
 */

/**
 * Потолок на всю транзакцию. У Prisma по умолчанию пять секунд, и на холодной
 * базе коммит крупной выписки упирался бы в них через раз — причём после
 * отката, то есть выглядел бы как случайный сбой.
 */
const TRANSACTION_TIMEOUT_MS = 120_000;
const TRANSACTION_MAX_WAIT_MS = 15_000;

export interface CommitDecision {
  index: number;
  include: boolean;
  categoryId?: string | null;
  projectId?: string | null;
  /** Свести с найденной встречной операцией в перевод. */
  mergeTransfer?: boolean;
  /**
   * Записать строку, опознанную как вывод эквайринга, обычным доходом.
   * Нужна на случай, когда распознавание ошиблось: настоящий платёж клиента,
   * в назначении которого упомянута ЮKassa.
   */
  settlementAsIncome?: boolean;
}

export interface CommitResult {
  created: number;
  merged: number;
  skippedAsDuplicate: number;
  alreadyCommitted: boolean;
}

export async function commitBatch(input: {
  batchId: string;
  fingerprint: string;
  decisions: CommitDecision[];
  acknowledgeWarnings?: boolean;
}): Promise<CommitResult> {
  const batch = await prisma.importBatch.findUnique({
    where: { id: input.batchId },
    select: { id: true, status: true, parsedRows: true, stats: true },
  });
  if (!batch) throw new ImportError("Импорт не найден.", "state");

  const stats = batch.stats as unknown as ImportStats | null;

  if (batch.status === "COMMITTED") {
    // Двойной клик по кнопке — не ошибка и не повод записать всё второй раз.
    return {
      created: stats?.committed?.created ?? 0,
      merged: stats?.committed?.merged ?? 0,
      skippedAsDuplicate: stats?.committed?.skippedAsDuplicate ?? 0,
      alreadyCommitted: true,
    };
  }
  if (batch.status !== "PREVIEW" && batch.status !== "NEEDS_REVIEW") {
    throw new ImportError(`Импорт в состоянии «${batch.status}» подтвердить нельзя.`, "state");
  }
  if (!stats || !Array.isArray(batch.parsedRows)) {
    throw new ImportError("Разобранных строк не осталось — загрузи файл заново.", "state");
  }

  const rows = batch.parsedRows as unknown as ClassifiedRow[];

  if (fingerprintRows(rows) !== input.fingerprint) {
    // Вкладка, открытая вчера, не должна подтверждать импорт по строкам,
    // которых уже нет.
    throw new ImportError("Предпросмотр устарел — открой импорт заново.", "stale");
  }
  if (batch.status === "NEEDS_REVIEW" && !input.acknowledgeWarnings) {
    throw new ImportError(
      "В разборе есть предупреждения. Подтверди, что импортируем несмотря на них.",
      "state",
    );
  }

  const decisions = new Map(input.decisions.map((d) => [d.index, d]));
  const planned = planRows(rows, decisions);

  await validateReferences(planned);

  const merges: NonNullable<ImportStats["transferMerges"]> = [];
  let created = 0;

  let skippedLate = 0;

  await prisma.$transaction(
    async (tx) => {
      // ПЕРВЫМ делом партия забирается себе — атомарно, сменой статуса под
      // условием прежнего статуса.
      //
      // Проверка `status === "COMMITTED"` в начале функции читает базу ДО
      // транзакции, поэтому два одновременных подтверждения одной партии оба
      // её проходят. Пересчёт дедупа ниже такое не ловит: на уровне READ
      // COMMITTED транзакции не видят незакоммиченных вставок друг друга, и
      // обе честно решают, что строк ещё нет. Раньше от этого спасал
      // уникальный индекс — второй коммит падал целиком; после его снятия
      // выписка молча удваивалась. Проверено на живой базе: 12 операций
      // вместо 6.
      //
      // `updateMany` берёт блокировку строки партии: второй вызов ждёт первый,
      // затем перечитывает условие, видит COMMITTED и получает count = 0.
      const claimed = await tx.importBatch.updateMany({
        where: { id: batch.id, status: { in: ["PREVIEW", "NEEDS_REVIEW"] } },
        data: { status: "COMMITTED" },
      });
      if (claimed.count !== 1) {
        throw new ImportError(
          "Этот импорт уже подтверждается или подтверждён — обнови страницу.",
          "conflict",
        );
      }

      // Дедуп пересчитывается ЗДЕСЬ, внутри транзакции, а не только при
      // разборе. Строки классифицируются при загрузке файла и лежат в
      // parsedRows до подтверждения — между этими моментами база могла
      // измениться: вторая вкладка с тем же файлом, синк ЮKassa, повторная
      // загрузка. Отпечаток строк такого не ловит: он сверяет разбор сам с
      // собой, а не с базой.
      //
      // Раньше этот случай ловил уникальный индекс по (accountId, dedupKey) —
      // грубо, пятисоткой посреди партии, но ловил. Индекса больше нет (две
      // одинаковые операции одного дня законны), поэтому проверка нужна явная,
      // иначе два подтверждения одного файла удвоят выписку.
      const late = await lateDuplicates(tx, planned.toWrite, stats.accountId);
      await assertSettlementsStillCovered(tx, planned.toWrite, late);

      for (const [index, item] of planned.toWrite.entries()) {
        if (late.has(index)) {
          skippedLate += 1;
          continue;
        }
        // Вывод эквайринга пишется НЕ доходом на банковский счёт, а
        // перемещением со счёта ЮKassa на него: эта выручка уже учтена синком,
        // и вторая доходная строка удваивала бы месячный оборот. Направление
        // перевода задаётся парой полей: accountId — откуда, transferAccountId
        // — куда.
        const asSettlement = item.settlement;
        await createTransaction(
          {
            type: asSettlement ? "TRANSFER" : item.row.type,
            amountKop: item.row.amountKop,
            date: new Date(item.row.date),
            accountId: asSettlement ? YOOKASSA_ACCOUNT_ID : stats.accountId,
            transferAccountId: asSettlement ? stats.accountId : null,
            // Категория дохода на переводе — мусор: в отчётах перевод не
            // участвует, а в списке операций смотрелся бы выручкой.
            categoryId: asSettlement ? null : item.categoryId,
            projectId: item.projectId,
            note: item.row.description,
            source: "IMPORT",
            dedupKey: asSettlement ? item.row.settlementDedupKey : item.row.dedupKey,
            importBatchId: batch.id,
            meta: item.row.mcc === null ? undefined : ({ mcc: item.row.mcc } as Prisma.InputJsonValue),
          },
          tx,
        );
        created += 1;
      }

      for (const item of planned.toMerge) {
        const existing = await tx.transaction.findUnique({
          where: {
            id: item.counterpartId,
          },
          select: {
            id: true,
            type: true,
            accountId: true,
            dedupKey: true,
            transferAccountId: true,
          },
        });
        if (!existing) continue;

        /**
         * Направление перевода задаёт СТРОКА ВЫПИСКИ, а не то, на каком счёте
         * лежала встречная операция.
         *
         * У перевода одна строка: `accountId` — откуда ушло, `transferAccountId`
         * — куда пришло. Раньше сюда безусловно писалось «со счёта встречной
         * операции на счёт выписки», и для приходной строки это верно, а для
         * расходной — наоборот. Расход в выписке означает, что деньги ушли СО
         * счёта выписки; запись же утверждала обратное, и оба остатка
         * разъезжались на двойную сумму. В отчётах перевод не виден, поэтому
         * заметить это можно было только сверкой остатка с банком.
         */
        const fromStatement = item.rowType === "EXPENSE";
        const accountId = fromStatement ? stats.accountId : existing.accountId;
        const transferAccountId = fromStatement ? existing.accountId : stats.accountId;

        /**
         * У сведённого перевода ДВЕ личности, и обе надо сохранить.
         *
         * Строка второй выписки не записывается отдельной операцией — иначе
         * перевод удвоился бы. Но её ключ дедупа тогда не остаётся нигде, и
         * повторный импорт пересекающегося периода не находит перевод, считает
         * строку новой и пишет те же деньги второй раз.
         *
         * Поэтому операция несёт свой ключ (accountId + dedupKey) и ключ той
         * выписки, из которой её свели (mergedAccountId + mergedDedupKey).
         * Когда направление переворачивается, местами меняются и они: своим
         * становится ключ выписки, вторым — ключ встречной операции.
         */
        const ownKey = fromStatement ? item.dedupKey : existing.dedupKey;
        const mergedAccountId = fromStatement ? existing.accountId : stats.accountId;
        const mergedDedupKey = fromStatement ? existing.dedupKey : item.dedupKey;

        // Что именно изменили — записываем, иначе откат не сможет вернуть
        // операцию в прежний вид, и в базе останется след импорта, который
        // владелец отменил.
        merges.push({
          txId: existing.id,
          previousType: existing.type,
          previousTransferAccountId: existing.transferAccountId,
          previousAccountId: existing.accountId,
          previousDedupKey: existing.dedupKey,
        });

        await tx.transaction.update({
          where: { id: existing.id },
          data: {
            type: "TRANSFER",
            accountId,
            transferAccountId,
            dedupKey: ownKey,
            mergedAccountId,
            mergedDedupKey,
          },
        });
      }

      await tx.importBatch.update({
        where: { id: batch.id },
        data: {
          status: "COMMITTED",
          committedAt: new Date(),
          stats: {
            ...stats,
            committed: {
              created,
              merged: merges.length,
              skippedAsDuplicate: planned.duplicates + skippedLate,
            },
            transferMerges: merges,
          } as unknown as Prisma.InputJsonValue,
        },
      });

      await tx.domainEvent.create({
        data: {
          module: "finance",
          type: "import.committed",
          title: `Импорт выписки: ${created} операций`,
          payload: { batchId: batch.id, created, merged: merges.length },
        },
      });
    },
    { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
  );

  logInfo("finance.import_committed", {
    batchId: batch.id,
    created,
    merged: merges.length,
    // Ненулевое значение означает, что база изменилась между предпросмотром и
    // подтверждением, — например, тот же файл подтвердили дважды.
    skippedLate,
  });
  return {
    created,
    merged: merges.length,
    skippedAsDuplicate: planned.duplicates + skippedLate,
    alreadyCommitted: false,
  };
}

interface PlannedWrite {
  row: ClassifiedRow;
  categoryId: string | null;
  projectId: string | null;
  /** Писать переводом со счёта ЮKassa, а не доходом на счёт выписки. */
  settlement: boolean;
}

/** Счёт и ключ, под которыми строка ляжет в базу. */
function targetOf(item: PlannedWrite, statementAccountId: string): { accountId: string; key: string } {
  return item.settlement
    ? { accountId: YOOKASSA_ACCOUNT_ID, key: item.row.settlementDedupKey ?? "" }
    : { accountId: statementAccountId, key: item.row.dedupKey };
}

/**
 * Хватает ли на счёте ЮKassa выручки под все выводы этой партии — ещё раз, уже
 * внутри транзакции.
 *
 * Решение «это вывод, а не доход» принимается при разборе, по остатку счёта на
 * тот момент. Между разбором и подтверждением остаток меняется: подтвердили
 * соседнюю выписку, прошёл синк, откатили партию. Два предпросмотра, открытых
 * одновременно, вообще видят один и тот же остаток и каждый считает его своим.
 *
 * Записать вывод, под который выручки уже нет, — значит увести виртуальный счёт
 * в минус и стереть из доходов деньги, которых там больше не покрыто. Лучше
 * отказать и попросить открыть импорт заново: предпросмотр дешёвый, выручка нет.
 */
async function assertSettlementsStillCovered(
  tx: Prisma.TransactionClient,
  toWrite: PlannedWrite[],
  skip: Set<number>,
): Promise<void> {
  const needKop = toWrite
    .filter((item, index) => item.settlement && !skip.has(index))
    .reduce((sum, item) => sum + item.row.amountKop, 0);
  if (needKop === 0) return;

  const [incoming, outgoing] = await Promise.all([
    tx.transaction.aggregate({
      where: { accountId: YOOKASSA_ACCOUNT_ID, type: "INCOME" },
      _sum: { amountKop: true },
    }),
    tx.transaction.aggregate({
      where: { accountId: YOOKASSA_ACCOUNT_ID, type: { in: ["EXPENSE", "TRANSFER"] } },
      _sum: { amountKop: true },
    }),
  ]);
  const availableKop = (incoming._sum.amountKop ?? 0) - (outgoing._sum.amountKop ?? 0);

  if (availableKop < needKop) {
    throw new ImportError(
      "Пока импорт был открыт, неучтённой выручки на счёте «ЮKassa» стало меньше, " +
        "чем нужно на выводы из этой выписки. Открой импорт заново — строки " +
        "переразберутся по актуальному остатку.",
      "stale",
    );
  }
}

/**
 * Индексы строк, которые за время предпросмотра успели появиться в базе.
 *
 * Правило то же, что и при разборе, и это не случайно: сколько операций с таким
 * ключом уже лежит на этом счёте, столько ПЕРВЫХ строк партии с ним и лишние.
 * Проверять «есть ли» вместо «сколько» здесь нельзя ровно по той же причине,
 * что и там: две одинаковые операции одного дня — законная пара.
 */
async function lateDuplicates(
  tx: Prisma.TransactionClient,
  toWrite: PlannedWrite[],
  statementAccountId: string,
): Promise<Set<number>> {
  const skip = new Set<number>();
  const keysByAccount = new Map<string, Set<string>>();

  for (const item of toWrite) {
    const { accountId, key } = targetOf(item, statementAccountId);
    if (!key) continue;
    const bucket = keysByAccount.get(accountId) ?? new Set<string>();
    bucket.add(key);
    keysByAccount.set(accountId, bucket);
  }
  if (keysByAccount.size === 0) return skip;

  const stored = new Map<string, number>();
  for (const [accountId, keys] of keysByAccount) {
    const rows = await tx.transaction.groupBy({
      by: ["dedupKey"],
      where: { accountId, dedupKey: { in: [...keys] } },
      _count: { _all: true },
    });
    for (const row of rows) {
      if (row.dedupKey) stored.set(`${accountId}|${row.dedupKey}`, row._count._all);
    }
  }

  const used = new Map<string, number>();
  for (const [index, item] of toWrite.entries()) {
    const { accountId, key } = targetOf(item, statementAccountId);
    if (!key) continue;
    const id = `${accountId}|${key}`;
    const seen = used.get(id) ?? 0;
    used.set(id, seen + 1);
    if (seen < (stored.get(id) ?? 0)) skip.add(index);
  }

  return skip;
}

interface Plan {
  toWrite: PlannedWrite[];
  /**
   * `rowType` и `dedupKey` — от СТРОКИ ВЫПИСКИ, а не от встречной операции:
   * первым задаётся направление перевода, вторым — вторая личность операции,
   * без которой повторный импорт создаёт перевод заново.
   */
  toMerge: Array<{ counterpartId: string; rowType: "INCOME" | "EXPENSE"; dedupKey: string }>;
  duplicates: number;
}

/**
 * Что именно будет записано.
 *
 * Решения клиента ограничены двумя вещами: не писать строку и сменить ей
 * категорию. Ни суммы, ни даты, ни счёта в них нет — они берутся из строк,
 * разобранных на сервере.
 */
export function planRows(rows: ClassifiedRow[], decisions: Map<number, CommitDecision>): Plan {
  const toWrite: PlannedWrite[] = [];
  const toMerge: Plan["toMerge"] = [];
  let duplicates = 0;

  for (const row of rows) {
    const decision = decisions.get(row.index);

    if (row.rowClass === "duplicate") {
      // Дубль не пишется никогда, даже если клиент попросил.
      //
      // Раньше за этим стоял уникальный индекс — он всё равно отверг бы
      // строку, и здесь она отвергалась осмысленно и заранее. Индекса больше
      // нет (ключ дедупа не уникален: две одинаковые операции одного дня —
      // законная пара), поэтому теперь ЭТА строка и есть весь механизм,
      // держащий инвариант «повторный импорт того же файла не создаёт новых
      // операций». Ослабить её — значит удваивать выписку при каждой повторной
      // загрузке.
      duplicates += 1;
      continue;
    }
    if (decision?.include === false) continue;

    if (row.rowClass === "transfer" && decision?.mergeTransfer && row.counterpartId) {
      toMerge.push({
        counterpartId: row.counterpartId,
        rowType: row.type,
        dedupKey: row.dedupKey,
      });
      continue;
    }

    // Вывод эквайринга по умолчанию пишется переводом. Владелец может вернуть
    // его в доходы одной галочкой — на случай настоящего платежа клиента, в
    // назначении которого упомянута ЮKassa.
    const settlement =
      row.rowClass === "settlement" &&
      decision?.settlementAsIncome !== true &&
      Boolean(row.settlementDedupKey);

    toWrite.push({
      row,
      categoryId: settlement
        ? null
        : decision?.categoryId !== undefined
          ? decision.categoryId
          : row.categoryId,
      projectId: decision?.projectId ?? null,
      settlement,
    });
  }

  return { toWrite, toMerge, duplicates };
}

/**
 * Проверка ссылок ДО открытия транзакции.
 *
 * Неизвестный `categoryId` внутри транзакции взорвал бы её нарушением внешнего
 * ключа на середине партии — владелец получил бы пятисотку вместо понятного
 * «такой категории нет».
 */
async function validateReferences(plan: Plan): Promise<void> {
  const categoryIds = [...new Set(plan.toWrite.map((w) => w.categoryId).filter(isId))];
  const projectIds = [...new Set(plan.toWrite.map((w) => w.projectId).filter(isId))];

  if (categoryIds.length > 0) {
    const found = await prisma.category.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, type: true },
    });
    const byId = new Map(found.map((c) => [c.id, c.type]));

    for (const item of plan.toWrite) {
      if (!item.categoryId) continue;
      const type = byId.get(item.categoryId);
      if (!type) throw new ImportError("Выбрана несуществующая категория.", "input");
      if (type !== item.row.type) {
        throw new ImportError("Категория не того направления: доход в расход не кладётся.", "input");
      }
    }
  }

  if (projectIds.length > 0) {
    const count = await prisma.project.count({ where: { id: { in: projectIds } } });
    if (count !== projectIds.length) throw new ImportError("Выбран несуществующий проект.", "input");
  }
}

function isId(value: string | null): value is string {
  return typeof value === "string" && value.length > 0;
}
