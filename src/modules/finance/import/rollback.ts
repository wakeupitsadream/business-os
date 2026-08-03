import { Prisma, type TxType } from "@prisma/client";
import { prisma } from "@/core/db";
import { logInfo } from "@/core/observability/logger";
import { ImportError, type ImportStats } from "./batch";

/**
 * Откат импорта целиком.
 *
 * Удаляются ОПЕРАЦИИ, а сам `ImportBatch` остаётся. Удалить батч было бы
 * заманчиво и неверно: у `Transaction.importBatchId` стоит `onDelete: SetNull`,
 * и денежные строки остались бы в отчётах без единого следа происхождения —
 * ровно то, что потом невозможно объяснить при сверке с банком.
 */
export async function rollbackBatch(batchId: string): Promise<{ deleted: number; restored: number }> {
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    select: { id: true, status: true, stats: true },
  });
  if (!batch) throw new ImportError("Импорт не найден.", "state");
  if (batch.status !== "COMMITTED") {
    throw new ImportError("Откатывать нечего: импорт не был подтверждён.", "state");
  }

  const stats = batch.stats as unknown as ImportStats | null;
  const merges = stats?.transferMerges ?? [];

  let deleted = 0;
  let restored = 0;

  await prisma.$transaction(async (tx) => {
    // Сначала возвращаем то, что импорт изменил в чужих операциях: они не
    // принадлежат батчу и удалением не уберутся.
    for (const merge of merges) {
      const updated = await tx.transaction.updateMany({
        where: { id: merge.txId, type: "TRANSFER" },
        data: {
          type: merge.previousType as TxType,
          transferAccountId: merge.previousTransferAccountId,
          // Сведение расходной ноги переносит операцию на счёт выписки —
          // значит откат обязан вернуть и счёт. Иначе тип восстановится, а
          // операция останется на чужом счёте, и остаток разъедется уже ПОСЛЕ
          // отмены импорта. У старых партий поля нет: счёт тогда не менялся.
          ...(merge.previousAccountId ? { accountId: merge.previousAccountId } : {}),
          // Ключ сведённой строки принадлежал откатываемой партии — вместе с
          // ней он и уходит, иначе повторный импорт того же периода счёл бы
          // строку уже записанной и молча её потерял.
          mergedDedupKey: null,
        },
      });
      restored += updated.count;
    }

    const removed = await tx.transaction.deleteMany({ where: { importBatchId: batchId } });
    deleted = removed.count;

    await tx.importBatch.update({
      where: { id: batchId },
      data: {
        status: "CANCELLED",
        committedAt: null,
        // Сырьё НЕ стираем.
        //
        // Откат — это «импорт лёг не так», и обычно за ним следует «загрузить
        // заново». Раньше та же транзакция уничтожала и файл выписки, и разбор:
        // владелец, откативший партию, оставался без единственной копии — CSV
        // он скачал на телефон и удалил, а банк формирует выписку по запросу.
        // Восстановить было нечем: rawFile никто не читает, в UI его нет.
        //
        // Срок хранения задаёт purgeImportArtifacts (30 дней): ветка
        // CANCELLED/FAILED подберёт откатанную партию сама, обещание «выписки
        // не живут дольше месяца» не страдает. cancelBatch трогать незачем —
        // там владелец отменяет НЕподтверждённый предпросмотр через минуту
        // после загрузки, файл у него в руках, и стирание там осознанное.
        stats: {
          ...(stats ?? {}),
          committed: undefined,
          transferMerges: [],
        } as unknown as Prisma.InputJsonValue,
      },
    });

    await tx.domainEvent.create({
      data: {
        module: "finance",
        type: "import.rolled_back",
        title: `Импорт отменён: удалено ${deleted} операций`,
        payload: { batchId, deleted, restored },
      },
    });
  });

  logInfo("finance.import_rolled_back", { batchId, deleted, restored });
  return { deleted, restored };
}

/** Отмена неподтверждённого импорта: файл и разбор больше не нужны. */
export async function cancelBatch(batchId: string): Promise<boolean> {
  const updated = await prisma.importBatch.updateMany({
    where: { id: batchId, status: { in: ["UPLOADED", "PARSING", "PREVIEW", "NEEDS_REVIEW", "FAILED"] } },
    data: { status: "CANCELLED", rawFile: null, parsedRows: Prisma.DbNull },
  });
  return updated.count > 0;
}
