import type { Prisma } from "@prisma/client";
import { prisma } from "@/core/db";
import { logInfo } from "@/core/observability/logger";
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

/** Счёт ЮKassa из сид-миграции — источник переводов на банковский счёт. */
const YOOKASSA_ACCOUNT_ID = "acc_yookassa";

export interface CommitDecision {
  index: number;
  include: boolean;
  categoryId?: string | null;
  projectId?: string | null;
  /** Свести с найденной встречной операцией в перевод. */
  mergeTransfer?: boolean;
  /**
   * Записать поступление с ЮKassa доходом, а не переводом. Владелец видит
   * строку и решает сам: система лишь узнаёт её по описанию и может ошибиться.
   */
  keepAsIncome?: boolean;
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
  let lateDuplicates = 0;

  await prisma.$transaction(
    async (tx) => {
      // Строки заморожены с момента предпросмотра, а база с тех пор могла
      // измениться: два предпросмотра пересекающихся периодов, открытые
      // подряд, — обычное дело в конце месяца. Без этой сверки вторая партия
      // упиралась в уникальный индекс, вся транзакция откатывалась, и владелец
      // получал 500 вместо внятного ответа; предпросмотр при этом оставался
      // прежним, так что повтор давал ту же ошибку — помогала только повторная
      // загрузка файла.
      //
      // Проверка идёт ВНУТРИ транзакции, потому что снаружи она ничего не
      // гарантирует: между проверкой и записью успевает пройти чужой коммит.
      const plannedKeys = [
        ...planned.toWrite.map((i) => i.row.dedupKey),
        ...planned.toSettle.map((i) => i.row.dedupKey),
      ].filter((k): k is string => typeof k === "string" && k.length > 0);

      const takenRows = plannedKeys.length
        ? await tx.transaction.findMany({
            where: { dedupKey: { in: plannedKeys } },
            select: { dedupKey: true },
          })
        : [];
      const taken = new Set(takenRows.map((r) => r.dedupKey).filter((k): k is string => k !== null));

      for (const item of planned.toWrite) {
        if (item.row.dedupKey && taken.has(item.row.dedupKey)) {
          lateDuplicates += 1;
          continue;
        }
        await createTransaction(
          {
            type: item.row.type,
            amountKop: item.row.amountKop,
            date: new Date(item.row.date),
            accountId: stats.accountId,
            categoryId: item.categoryId,
            projectId: item.projectId,
            note: item.row.description,
            source: "IMPORT",
            dedupKey: item.row.dedupKey,
            importBatchId: batch.id,
            meta: item.row.mcc === null ? undefined : ({ mcc: item.row.mcc } as Prisma.InputJsonValue),
          },
          tx,
        );
        created += 1;
      }

      // Перевод собственных денег с ЮKassa на счёт выписки. Операция ложится
      // на счёт-ИСТОЧНИК (`accountId`), получатель — в `transferAccountId`:
      // так считает остатки вся система. Доходом эти деньги не становятся —
      // они уже посчитаны платежами клиентов, которые записал синк.
      for (const item of planned.toSettle) {
        if (item.row.dedupKey && taken.has(item.row.dedupKey)) {
          lateDuplicates += 1;
          continue;
        }
        await createTransaction(
          {
            type: "TRANSFER",
            amountKop: item.row.amountKop,
            date: new Date(item.row.date),
            accountId: YOOKASSA_ACCOUNT_ID,
            transferAccountId: stats.accountId,
            projectId: item.projectId,
            note: item.row.description,
            source: "IMPORT",
            // Ключ строки сохраняется, хотя операция ложится на другой счёт:
            // без него повторный импорт пересекающегося периода создал бы
            // перевод заново. Поиск дублей ищет по ключу, не ограничиваясь
            // счётом выписки, — см. loadExistingKeys.
            dedupKey: item.row.dedupKey,
            importBatchId: batch.id,
            meta: { kind: "yookassa_settlement" } as Prisma.InputJsonValue,
          },
          tx,
        );
        created += 1;
      }

      for (const item of planned.toMerge) {
        const existing = await tx.transaction.findUnique({
          where: { id: item.counterpartId },
          select: { id: true, type: true, transferAccountId: true },
        });
        if (!existing) continue;

        // Что именно изменили — записываем, иначе откат не сможет вернуть
        // операцию в прежний вид, и в базе останется след импорта, который
        // владелец отменил.
        merges.push({
          txId: existing.id,
          previousType: existing.type,
          previousTransferAccountId: existing.transferAccountId,
        });

        await tx.transaction.update({
          where: { id: existing.id },
          data: { type: "TRANSFER", transferAccountId: stats.accountId },
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
              // Дубли, найденные при разборе, и дубли, появившиеся между
              // предпросмотром и подтверждением, — одно и то же для владельца:
              // строка не записана, потому что такая уже есть.
              skippedAsDuplicate: planned.duplicates + lateDuplicates,
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

  logInfo("finance.import_committed", { batchId: batch.id, created, merged: merges.length });
  return {
    created,
    merged: merges.length,
    skippedAsDuplicate: planned.duplicates + lateDuplicates,
    alreadyCommitted: false,
  };
}

interface PlannedWrite {
  row: ClassifiedRow;
  categoryId: string | null;
  projectId: string | null;
}

interface Plan {
  toWrite: PlannedWrite[];
  toMerge: Array<{ counterpartId: string }>;
  /** Поступления с ЮKassa: пишутся переводом со счёта ЮKassa, а не доходом. */
  toSettle: Array<{ row: ClassifiedRow; projectId: string | null }>;
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
  const toMerge: Array<{ counterpartId: string }> = [];
  const toSettle: Plan["toSettle"] = [];
  let duplicates = 0;

  for (const row of rows) {
    const decision = decisions.get(row.index);

    if (row.rowClass === "duplicate") {
      // Дубль не пишется никогда, даже если клиент попросил. Уникальный индекс
      // всё равно бы его отверг — лучше отвергнуть осмысленно и заранее.
      duplicates += 1;
      continue;
    }
    if (decision?.include === false) continue;

    if (row.rowClass === "transfer" && decision?.mergeTransfer && row.counterpartId) {
      toMerge.push({ counterpartId: row.counterpartId });
      continue;
    }

    // Перевод с ЮKassa: доходом становится только по явной просьбе владельца.
    // По умолчанию именно перевод — ошибка в эту сторону видна (не хватает
    // дохода), а в обратную незаметна: выручка тихо удваивается.
    if (row.rowClass === "settlement" && !decision?.keepAsIncome) {
      toSettle.push({ row, projectId: decision?.projectId ?? null });
      continue;
    }

    toWrite.push({
      row,
      categoryId: decision?.categoryId !== undefined ? decision.categoryId : row.categoryId,
      projectId: decision?.projectId ?? null,
    });
  }

  return { toWrite, toMerge, toSettle, duplicates };
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
