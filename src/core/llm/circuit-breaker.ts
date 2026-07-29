import { envInt } from "@/core/env";
import { logInfo, logWarn } from "@/core/observability/logger";

/**
 * Circuit breaker вариантов «шлюз + модель».
 *
 * Без памяти о здоровье деградировавший шлюз отъедает полный цикл ретраев у
 * КАЖДОГО запроса: пока провайдер висит, владелец ждёт ответа десятки секунд,
 * хотя рабочий резерв стоит следующим в каскаде. Жёсткий провал варианта
 * открывает брейкер на кулдаун — каскад просто пропускает больной вариант.
 *
 * Fail-open: если открыты ВСЕ варианты, пробуем несмотря на брейкеры —
 * медленный ответ лучше отказа. Память процессная: после рестарта контейнера
 * все варианты снова считаются здоровыми, отдельное хранилище тут избыточно.
 */

const DEFAULT_COOLDOWN_MS = 45_000;

/** Читается на каждый вызов, а не при импорте: env меняется без пересборки. */
function cooldownMs(): number {
  const value = envInt("LLM_BREAKER_COOLDOWN_MS", DEFAULT_COOLDOWN_MS);
  return value > 0 ? value : DEFAULT_COOLDOWN_MS;
}

const openUntil = new Map<string, number>();

export function breakerKey(gatewayId: string, model: string): string {
  return `${gatewayId}:${model}`;
}

export function isBreakerOpen(key: string): boolean {
  return (openUntil.get(key) ?? 0) > Date.now();
}

/** Жёсткий провал варианта (ретраи исчерпаны, таймаут, битый ответ). */
export function tripBreaker(key: string): void {
  const cooldown = cooldownMs();
  openUntil.set(key, Date.now() + cooldown);
  logWarn("llm.breaker_open", { key, cooldownMs: cooldown });
}

/** Успешный ответ — вариант снова здоров. */
export function resetBreaker(key: string): void {
  if (openUntil.delete(key)) logInfo("llm.breaker_closed", { key });
}

/**
 * Оставить только здоровые варианты, сохранив порядок каскада.
 * Если здоровых не осталось — вернуть исходный список (fail-open).
 */
export function filterHealthy<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const healthy = items.filter((item) => !isBreakerOpen(keyOf(item)));
  if (healthy.length > 0) return healthy;
  if (items.length > 0) logWarn("llm.breaker_fail_open", { variants: items.length });
  return [...items];
}

/** Для тестов. */
export function clearAllBreakers(): void {
  openUntil.clear();
}
