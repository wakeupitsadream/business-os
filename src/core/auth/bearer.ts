import { timingSafeEqual } from "node:crypto";
import { optionalEnv } from "@/core/env";

/**
 * Авторизация служебных роутов по `Authorization: Bearer <секрет>`.
 *
 * Вынесено из роута кронов, потому что таких мест стало два: кроны и проверка
 * базы в `/api/health`. Две копии сравнения секретов разъезжаются — одна
 * получает `timingSafeEqual`, вторая остаётся на `===`.
 *
 * Node-рантайм: `node:crypto` в Edge нет. Middleware этим не пользуется.
 */

/** Сравнение постоянного времени. Разная длина — сразу «нет», не бросая. */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function bearerToken(request: { headers: Headers }): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? "";
}

/**
 * Предъявлен ли `CRON_SECRET`.
 *
 * Незаданный секрет — это «нет», а не «пускаем всех»: иначе забытая
 * переменная окружения бесшумно открывает служебные роуты наружу.
 */
export function hasCronSecret(request: { headers: Headers }): boolean {
  const expected = optionalEnv("CRON_SECRET");
  if (!expected) return false;
  return secretsMatch(bearerToken(request), expected);
}
