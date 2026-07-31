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
 * Почему база недоступна — закрытый список, пригодный для публичного ответа.
 *
 * Категория вместо текста ошибки не «на всякий случай»: сообщение Prisma о
 * неудачном подключении содержит хост и порт (`P1001: Can't reach database
 * server at ep-….neon.tech:5432`), а при неудачной аутентификации — ещё и имя
 * пользователя БД. Это ровно те строки, которые нельзя отдавать наружу, и
 * срабатывало бы это в инцидент — когда база лежит и health дёргают все.
 */
export type DbFailureReason = "timeout" | "unreachable" | "auth" | "unknown";

export interface DbCheck {
  ok: boolean;
  reason?: DbFailureReason;
  /**
   * Полный текст ошибки — ТОЛЬКО для логов. В тело HTTP-ответа не попадает
   * никогда: см. тест `health-leak.test.ts`.
   */
  detail?: string;
}

/** Наша собственная гонка с таймером — отличаем от ошибок драйвера. */
const HEALTH_TIMEOUT = "db health timeout";

/**
 * Код ошибки Prisma → категория. Коды документированы и стабильны, разбор
 * текста сообщения был бы гаданием на локали.
 *
 * Полей ДВА, и это не перестраховка: `PrismaClientKnownRequestError` кладёт код
 * в `code`, а `PrismaClientInitializationError` — в `errorCode`. Ошибки
 * подключения (P1001 «не достучались», P1000 «не та пара логин/пароль») — это
 * как раз второй класс, то есть чтение одного `code` промахивалось бы мимо
 * самого частого случая и всё сваливало в «unknown».
 */
function classify(e: unknown): DbFailureReason {
  const message = e instanceof Error ? e.message : "";
  if (message === HEALTH_TIMEOUT) return "timeout";

  const raw = e as { code?: unknown; errorCode?: unknown };
  const code = typeof raw?.errorCode === "string" ? raw.errorCode : raw?.code;
  switch (typeof code === "string" ? code : "") {
    case "P1000": // Authentication failed
      return "auth";
    case "P1001": // Can't reach database server
    case "P1017": // Server has closed the connection
      return "unreachable";
    case "P1002": // The database server was reached but timed out
      return "timeout";
    default:
      return "unknown";
  }
}

/**
 * Быстрая проверка доступности БД для /api/health.
 * Таймаут обязателен: без него health висит до дефолтного таймаута драйвера,
 * а Timeweb успевает посчитать контейнер мёртвым.
 */
export async function checkDatabase(timeoutMs = 3_000): Promise<DbCheck> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(HEALTH_TIMEOUT)), timeoutMs);
      }),
    ]);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: classify(e),
      detail: e instanceof Error ? e.message : "unknown db error",
    };
  } finally {
    // Без этого проигравший таймер держит процесс живым до срабатывания.
    if (timer) clearTimeout(timer);
  }
}
