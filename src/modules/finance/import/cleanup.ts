import { Prisma } from "@prisma/client";
import { prisma } from "@/core/db";

/**
 * Чистка следов импорта.
 *
 * Срок хранения — зона ответственности модуля, а не крона: крон задаёт только
 * расписание. Так же устроена чистка дедупа вебхуков, и по той же причине —
 * две независимые реализации политики хранения разъезжаются при первом же её
 * изменении.
 *
 * Банковская выписка в базе дольше нужного — лишний риск без пользы: после
 * коммита операции уже разобраны, а сырой файл нужен только чтобы повторить
 * разбор, если парсер починили в ближайшие недели.
 */

export const RAW_FILE_TTL_DAYS = 30;

export interface CleanupResult {
  purgedCommitted: number;
  purgedAbandoned: number;
  expiredPreviews: number;
}

export async function purgeImportArtifacts(
  olderThanDays = RAW_FILE_TTL_DAYS,
  now: Date = new Date(),
): Promise<CleanupResult> {
  const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000);

  // Условие `rawFile: { not: null }` делает повторный прогон честным нулём, а
  // не «удалено 214» каждую ночь на одних и тех же записях.
  const purgedCommitted = await prisma.importBatch.updateMany({
    where: { status: "COMMITTED", committedAt: { lt: cutoff }, rawFile: { not: null } },
    data: { rawFile: null, parsedRows: Prisma.DbNull },
  });

  // Комментарий в схеме обещает удаление после коммита — но брошенная
  // десятимегабайтная выписка в FAILED живёт вечно, и обещание «выписки не
  // хранятся дольше 30 дней» оказалось бы неправдой.
  const purgedAbandoned = await prisma.importBatch.updateMany({
    where: {
      status: { in: ["CANCELLED", "FAILED"] },
      createdAt: { lt: cutoff },
      rawFile: { not: null },
    },
    data: { rawFile: null, parsedRows: Prisma.DbNull },
  });

  // Заодно подбираются батчи, застрявшие в PARSING из-за рестарта контейнера
  // посреди разбора.
  const expiredPreviews = await prisma.importBatch.updateMany({
    where: {
      status: { in: ["UPLOADED", "PARSING", "PREVIEW", "NEEDS_REVIEW"] },
      createdAt: { lt: cutoff },
    },
    data: { status: "CANCELLED", rawFile: null, parsedRows: Prisma.DbNull },
  });

  return {
    purgedCommitted: purgedCommitted.count,
    purgedAbandoned: purgedAbandoned.count,
    expiredPreviews: expiredPreviews.count,
  };
}
