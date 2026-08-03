import { PrismaClient } from "@prisma/client";

/**
 * Единственный экземпляр Prisma-клиента.
 *
 * В dev Next.js пересоздаёт модули при hot-reload — без глобального кэша
 * каждое изменение файла открывало бы новый пул соединений к Neon и быстро
 * упиралось в лимит подключений проекта.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/** Грубая причина недоступности базы — то немногое, что можно показать наружу. */
export type DbFailureKind = "unreachable" | "timeout" | "auth" | "unknown";

/**
 * Коды взяты из `scripts/migrate-error-kind.mjs` — там тот же список живёт для
 * скрипта миграций. Сам модуль сюда не тянем: он отвечает на другой вопрос
 * («стартовать ли контейнеру») и намеренно не отличает отказ авторизации от
 * сетевого сбоя, а здесь эта разница как раз и нужна.
 */
const UNREACHABLE =
  /P1001|P1002\b|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ECONNRESET|Can't reach database|Connection refused|could not connect|server closed the connection/i;
const AUTH = /P1000\b|P1010\b|authentication failed|password authentication|not authorized|permission denied/i;

/** Человеческая формулировка причины — без хостов и имён пользователей. */
export function describeDbFailure(kind: DbFailureKind | undefined): string {
  switch (kind) {
    case "unreachable":
      return "сервер базы не отвечает";
    case "timeout":
      return "база не ответила за отведённое время";
    case "auth":
      return "база отклонила подключение (доступ)";
    default:
      return "недоступна";
  }
}

export function classifyDbFailure(message: string): DbFailureKind {
  if (/db health timeout/i.test(message)) return "timeout";
  if (AUTH.test(message)) return "auth";
  if (UNREACHABLE.test(message)) return "unreachable";
  return "unknown";
}

/**
 * Быстрая проверка доступности БД для /api/health.
 * Таймаут обязателен: без него health висит до дефолтного таймаута драйвера,
 * а Timeweb успевает посчитать контейнер мёртвым.
 *
 * `detail` — сырой текст драйвера, и наружу он НЕ идёт. У Prisma в этом тексте
 * лежит хост базы (`ep-….eu-central-1.aws.neon.tech:5432`), а при неверном
 * пароле ещё и имя пользователя. Публичному ответу достаточно `kind`; полный
 * текст пишется в лог, его видно в панели хостинга.
 */
export async function checkDatabase(
  timeoutMs = 3_000,
): Promise<{ ok: boolean; kind?: DbFailureKind; detail?: string }> {
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("db health timeout")), timeoutMs),
      ),
    ]);
    return { ok: true };
  } catch (e) {
    const detail = e instanceof Error ? e.message : "unknown db error";
    return { ok: false, kind: classifyDbFailure(detail), detail };
  }
}
