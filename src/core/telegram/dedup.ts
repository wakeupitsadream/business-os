/**
 * Дедуп вебхуков по update_id — durable, в Postgres.
 *
 * In-memory здесь недостаточно: контейнер перезапускается при каждом деплое, и
 * после рестарта Telegram спокойно доставляет тот же апдейт заново (он ретраит
 * всё, на что не получил 200). Владелец получал бы дубли ответов.
 */

import { prisma } from "@/core/db";
import { logWarn } from "@/core/observability/logger";

const SOURCE = "telegram";

function isUniqueViolation(error: unknown): boolean {
  // Дуктайпинг вместо instanceof PrismaClientKnownRequestError: разные сборки
  // клиента дают разные классы, и проверка типа молча перестаёт срабатывать.
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Пытается «застолбить» апдейт. `true` — обрабатываем впервые, `false` — дубль.
 *
 * Запись создаётся ДО обработки: пока идёт генерация ответа (10+ секунд),
 * Telegram успевает прислать повтор.
 *
 * При недоступной БД возвращаем `true` (обрабатываем): для личного бота
 * «ответить дважды» — неприятность, «не ответить вовсе» — поломка.
 */
export async function claimUpdate(updateId: number | string): Promise<boolean> {
  const externalId = String(updateId);
  try {
    await prisma.webhookDedup.create({ data: { source: SOURCE, externalId } });
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    logWarn("telegram.dedup_unavailable", {
      externalId,
      error: error instanceof Error ? error.message : "unknown",
    });
    return true;
  }
}

/**
 * Чистка старых записей — вызывается ночным кроном. Без неё таблица растёт
 * бесконечно, а смысла хранить дедуп дольше нескольких дней нет: Telegram
 * бросает ретраи через сутки.
 */
export async function purgeWebhookDedup(olderThanDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const result = await prisma.webhookDedup.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return result.count;
}
