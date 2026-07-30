/**
 * Типизированный доступ к окружению.
 *
 * Принцип: приложение НЕ падает на старте из-за отсутствующей переменной —
 * это уронило бы контейнер целиком (урок Agentus: health должен отвечать даже
 * при неполной конфигурации). Вместо этого каждая подсистема сама проверяет
 * свои переменные и деградирует осмысленно: нет ключей LLM → чат отвечает
 * «шлюзы не настроены», нет токена бота → вебхук отдаёт 200 и молчит.
 *
 * `requireEnv` используют только те места, где работа без переменной
 * бессмысленна (подпись сессии).
 */

function read(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function optionalEnv(name: string): string | undefined {
  return read(name);
}

export function requireEnv(name: string): string {
  const v = read(name);
  if (!v) throw new Error(`Не задана обязательная переменная окружения ${name}`);
  return v;
}

export function envFlag(name: string): boolean {
  const v = read(name)?.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function envInt(name: string, fallback: number): number {
  const raw = read(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Базовый URL приложения. Нужен для ссылок в Telegram и в письмах.
 * Схема подставляется автоматически: панель Timeweb при сохранении env
 * обрезала «https://» (инцидент Agentus 09.07.2026) — голый хост не должен
 * ломать ссылки.
 */
export function appUrl(): string {
  const raw = read("APP_URL") ?? "http://localhost:3000";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

export const isProduction = process.env.NODE_ENV === "production";
export const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
