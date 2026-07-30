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

/**
 * Быстрая проверка доступности БД для /api/health.
 * Таймаут обязателен: без него health висит до дефолтного таймаута драйвера,
 * а Timeweb успевает посчитать контейнер мёртвым.
 */
export async function checkDatabase(timeoutMs = 3_000): Promise<{ ok: boolean; error?: string }> {
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("db health timeout")), timeoutMs),
      ),
    ]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "unknown db error" };
  }
}
