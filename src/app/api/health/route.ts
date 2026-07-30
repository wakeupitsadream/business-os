/**
 * Liveness-эндпоинт: «процесс жив и отвечает по HTTP».
 *
 * Осознанно ВСЕГДА отдаёт 200, даже когда база лежит. Урок Agentus: health,
 * отдающий 503 при недоступной БД, ломает деплой — Docker HEALTHCHECK падает,
 * хостинг считает новый контейнер битым и откатывается на старый образ, хотя
 * код исправен. Реальное состояние видно в теле: `ok` и `checks.database`.
 *
 * Тело намеренно скупое: эндпоинт открыт без авторизации (middleware пускает
 * его всегда), поэтому ни хостов, ни имён переменных окружения здесь нет.
 */

import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { checkDatabase } from "@/core/db";
import { logWarn } from "@/core/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * SHA коммита, из которого собран образ. Планировщик контейнера кладёт его в
 * BUILD_SHA, но в dev/при ручном запуске переменной нет — тогда читаем файл,
 * который пишет стадия build в Dockerfile. Один раз на процесс.
 *
 * Зачем: два деплоя из очереди Timeweb выкатываются не по порядку, и без
 * гарантированного ответа «какой коммит сейчас обслуживает трафик» разбор
 * инцидента превращается в гадание.
 */
const GIT_SHA: string = (() => {
  const fromEnv = process.env.BUILD_SHA?.trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(".build-sha", "utf8").trim() || "local";
  } catch {
    return "local";
  }
})();

const PROCESS_STARTED_AT = Date.now();

export async function GET(): Promise<NextResponse> {
  const startedAt = Date.now();
  const db = await checkDatabase();
  const latencyMs = Date.now() - startedAt;

  if (!db.ok) {
    // В теле ответа детали ошибки остаются (эндпоинт нужен для диагностики),
    // но в логи пишем отдельно — их видно в панели хостинга без запроса.
    logWarn("health.database_down", { error: db.error, latencyMs });
  }

  return NextResponse.json(
    {
      ok: db.ok,
      service: "business-os",
      gitSha: GIT_SHA,
      uptimeSec: Math.round((Date.now() - PROCESS_STARTED_AT) / 1000),
      checks: {
        database: db.ok
          ? { ok: true, latencyMs }
          : { ok: false, latencyMs, error: db.error ?? "unknown" },
      },
      time: new Date().toISOString(),
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
