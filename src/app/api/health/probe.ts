import { checkDatabase, type DbCheck } from "@/core/db";
import { logWarn } from "@/core/observability/logger";

/**
 * Проба базы для `/api/health` — отдельным модулем, а не внутри роута.
 *
 * Причина техническая: Next.js проверяет типы экспортов файла роута по
 * закрытому списку (`GET`, `dynamic`, `runtime`, …), и лишний экспорт —
 * например, сброс кэша для тестов — валит сборку. Причина по существу: кэш и
 * решение «что показывать наружу» стоит уметь проверять без построения
 * `NextRequest`.
 */

/**
 * Кэш пробы. Не средство защиты — от лишних походов в базу защищает
 * авторизация в роуте. Это вежливость к компьюту: владелец, обновляющий
 * страницу в момент разбора инцидента, не должен превращать это в поток
 * запросов к Neon.
 */
const PROBE_TTL_MS = 60_000;

let cached: { at: number; latencyMs: number; check: DbCheck } | null = null;

export interface DatabaseReport {
  checked: true;
  ok: boolean;
  latencyMs: number;
  /** 0 — проба только что сделана; больше нуля — ответ из кэша. */
  cachedAgeSec: number;
  /** Категория отказа. Текста ошибки здесь нет и быть не должно. */
  reason?: string;
}

export function resetHealthProbeCache(): void {
  cached = null;
}

export async function probeDatabase(now: number = Date.now()): Promise<DatabaseReport> {
  if (cached && now - cached.at < PROBE_TTL_MS) {
    return report(cached.check, cached.latencyMs, Math.round((now - cached.at) / 1000));
  }

  const startedAt = Date.now();
  const check = await checkDatabase();
  const latencyMs = Date.now() - startedAt;
  cached = { at: Date.now(), latencyMs, check };

  if (!check.ok) {
    // Полный текст ошибки — сюда и только сюда. Логгер виден в панели
    // хостинга, а разбирать инцидент по одной категории было бы нечем.
    logWarn("health.database_down", { reason: check.reason, error: check.detail, latencyMs });
  }

  return report(check, latencyMs, 0);
}

function report(check: DbCheck, latencyMs: number, cachedAgeSec: number): DatabaseReport {
  return {
    checked: true,
    ok: check.ok,
    latencyMs,
    cachedAgeSec,
    // Категория, а НЕ текст ошибки: в тексте живут хост, порт и имя
    // пользователя базы.
    ...(check.ok ? {} : { reason: check.reason ?? "unknown" }),
  };
}
