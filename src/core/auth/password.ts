/**
 * Пароль владельца: argon2id, хэш живёт в env OWNER_PASSWORD_HASH.
 *
 * @node-rs/argon2 — нативный модуль, доступен ТОЛЬКО в Node-рантайме
 * (в next.config.ts он в serverExternalPackages). Из middleware его импортировать
 * нельзя — там Edge. Отсюда разделение: пароль проверяется в route handler,
 * сессия — в middleware.
 */

import { verify } from "@node-rs/argon2";
import { optionalEnv } from "@/core/env";
import { logWarn } from "@/core/observability/logger";

export function passwordConfigured(): boolean {
  return Boolean(optionalEnv("OWNER_PASSWORD_HASH"));
}

/**
 * Проверка пароля против хэша из env.
 * Возвращает false при любой проблеме (нет хэша, хэш испорчен) — детали в лог,
 * наружу единый ответ «неверный пароль», чтобы форма не подсказывала атакующему.
 */
export async function verifyOwnerPassword(password: string): Promise<boolean> {
  const hash = optionalEnv("OWNER_PASSWORD_HASH");
  if (!hash) {
    logWarn("auth.password_hash_missing");
    return false;
  }
  if (!password) return false;

  try {
    return await verify(hash, password);
  } catch (error) {
    // Сюда попадаем, когда в env лежит не argon2-строка (частый случай:
    // хэш вставили обрезанным или в кавычках).
    logWarn("auth.password_hash_invalid", { error });
    return false;
  }
}
