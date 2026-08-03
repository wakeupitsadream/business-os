import { envInt } from "@/core/env";

/**
 * Лимит частоты для приёма заявок с сайта.
 *
 * Отдельно от лимита входа, потому что защищает от другого и стоит другого.
 * Вход защищают от перебора пароля — там жёстко: пять попыток за 15 минут.
 * Здесь наоборот: настоящие заявки терять нельзя, и порог должен быть заведомо
 * выше любого правдоподобного дня. Ограничение спасает не от «на одну заявку
 * больше», а от заливки после утечки секрета — секрет живёт в чужом
 * приложении и в его логах, и когда-нибудь утечёт.
 *
 * Хранилище — Map в памяти, как и у входа: контейнер один, перезапуск сбросит
 * счётчики (переживёт разве что деплой), а внешняя зависимость означала бы,
 * что её недоступность роняет приём заявок.
 */

/** Заявок за окно с одного адреса. Настоящий поток на порядок меньше. */
export const INBOUND_MAX_PER_WINDOW = 60;
export const INBOUND_WINDOW_MS = 60 * 60 * 1000;

export interface QuotaResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

const hits = new Map<string, number[]>();
let lastSweepAt = 0;

function maxPerWindow(): number {
  return Math.max(1, envInt("SALES_INBOUND_MAX_PER_HOUR", INBOUND_MAX_PER_WINDOW));
}

function sweep(now: number): void {
  if (now - lastSweepAt < INBOUND_WINDOW_MS) return;
  lastSweepAt = now;
  for (const [key, stamps] of hits) {
    if (stamps.length === 0 || (stamps[stamps.length - 1] ?? 0) <= now - INBOUND_WINDOW_MS) {
      hits.delete(key);
    }
  }
}

export function hitInboundQuota(key: string, now: number = Date.now()): QuotaResult {
  sweep(now);

  const cutoff = now - INBOUND_WINDOW_MS;
  const kept = (hits.get(key) ?? []).filter((t) => t > cutoff);
  const limit = maxPerWindow();

  if (kept.length >= limit) {
    hits.set(key, kept);
    const oldest = kept[0] ?? now;
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((oldest + INBOUND_WINDOW_MS - now) / 1000)),
    };
  }

  kept.push(now);
  hits.set(key, kept);
  return { allowed: true, remaining: limit - kept.length, retryAfterSec: 0 };
}

/** Только для тестов. */
export function resetInboundQuota(): void {
  hits.clear();
  lastSweepAt = 0;
}
