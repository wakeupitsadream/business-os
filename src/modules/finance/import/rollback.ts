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
          // Сведение могло переставить операцию на другой счёт (когда
          // направление задавала расходная строка выписки) и подменить ей ключ
          // дедупа. Вернуть только тип — значит оставить операцию на чужом
          // счёте: остаток разъедется, а причина будет не видна.
          //
          // Поля необязательные: партии, сведённые до этой правки, их не
          // записали. Тогда восстанавливаем что можем и не трогаем остальное —
          // молча подставить туда что-нибудь было бы хуже.
          ...(merge.previousAccountId ? { accountId: merge.previousAccountId } : {}),
          ...(merge.previousDedupKey !== undefined ? { dedupKey: merge.previousDedupKey } : {}),
          mergedAccountId: null,
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
        // Сырой файл и разбор НЕ стираются.
        //
        // Откат — это «я передумал», а не «сожги улики». Стирая файл в той же
        // транзакции, откат становился необратимым: чтобы вернуть операции,
        // владельцу нужна была та же выписка из банка заново, а откатывают
        // обычно как раз тогда, когда что-то пошло не так и хочется повторить.
        // Обещание «выписки не хранятся дольше 30 дней» при этом не страдает:
        // отменённые партии подбирает ночная чистка (`purgeImportArtifacts`),
        // и делает это по тому же сроку, что и для всех остальных.
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
