/**
 * Классификация исхода `prisma migrate deploy`.
 *
 * Вынесено из db-migrate-safe.mjs отдельным модулем ровно затем, чтобы это
 * можно было покрыть тестами: сам скрипт исполняет миграции при импорте, и
 * проверить его решения иначе нельзя. А проверять есть что — от этой
 * классификации зависит, поднимется контейнер или нет.
 *
 * Три исхода:
 *   "unreachable" — до базы физически не достучаться. Старт продолжаем: код
 *                   исправен, база вернётся, миграции применятся позже.
 *   "pooler"      — миграции пошли через пул соединений. Останавливаемся с
 *                   адресным объяснением: сама собой эта ошибка не пройдёт.
 *   "fatal"       — всё прочее (плохой SQL, дрейф схемы, отказ авторизации).
 *                   Останавливаемся: работать против несмигрированной схемы
 *                   хуже, чем не работать вовсе.
 */

/**
 * Ошибка advisory-lock. Содержит слова «Timed out», из-за чего раньше попадала
 * в разряд «база моргнула» — и контейнер поднимался без единой таблицы, отвечая
 * при этом 200 на /api/health (SELECT 1 через пул проходит). Проверяется первой.
 */
const POOLER = /advisory lock/i;

/**
 * Только СЕТЕВАЯ недоступность. Формулировки про авторизацию и права сюда
 * намеренно не входят: опечатка в пароле не «пройдёт сама», и первый деплой на
 * чистую базу навсегда остался бы без схемы, молча повторяя это решение на
 * каждом рестарте.
 */
const UNREACHABLE =
  /P1001|P1002\b|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ECONNRESET|Can't reach database|Connection refused|could not connect|server closed the connection/i;

/** @returns {"unreachable" | "pooler" | "fatal"} */
export function classifyMigrateFailure(output) {
  const text = String(output ?? "");
  if (POOLER.test(text)) return "pooler";
  if (UNREACHABLE.test(text)) return "unreachable";
  return "fatal";
}

/** Похожа ли строка подключения на пул Neon (миграции через него не проходят). */
export function looksPooled(connectionString) {
  return /-pooler\.|pgbouncer=true/i.test(String(connectionString ?? ""));
}
