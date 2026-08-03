/**
 * Диагностический health: «процесс жив» плюс состояние базы.
 *
 * Осознанно ВСЕГДА отдаёт 200, даже когда база лежит. Урок Agentus: health,
 * отдающий 503 при недоступной БД, ломает деплой — Docker HEALTHCHECK падает,
 * хостинг считает новый контейнер битым и откатывается на старый образ, хотя
 * код исправен. Реальное состояние видно в теле: `ok` и `checks.database`.
 *
 * **Проверка базы делается только для своих.** Роут открыт снаружи, а поход в
 * базу стоит денег: каждый запрос будит компьют Neon и держит его пять минут,
 * а лимит компьют-часов общий на весь аккаунт. Без этого условия любой
 * желающий выкачивал бы квоту в цикле, заодно узнавая, лежит ли база. Своими
 * считаются сессия владельца и `Bearer CRON_SECRET` — тот же ключ, что у
 * `/api/cron/*`.
 *
 * Проба живости контейнера ходит НЕ сюда, а на `/api/health/live` — там нет ни
 * базы, ни условий.
 *
 * Наружу не уходит текст драйвера: у Prisma в нём хост базы
 * (`ep-….neon.tech:5432`), а при неверном пароле ещё и имя пользователя.
 * В теле только грубая категория, полный текст — в лог.
 */

import { readFileSync } from "node:fs";
import { NextResponse, type NextRequest } from "next/server";
import { checkDatabase } from "@/core/db";
import { isAuthenticated } from "@/core/auth/session";
import { optionalEnv } from "@/core/env";
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

/** Сессия владельца или тот же ключ, что у кронов. */
async function isInsider(request: NextRequest): Promise<boolean> {
  const secret = optionalEnv("CRON_SECRET");
  const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization")?.trim() ?? "")?.[1];
  if (secret && token === secret) return true;
  return isAuthenticated();
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const base = {
    service: "business-os",
    gitSha: GIT_SHA,
    uptimeSec: Math.round((Date.now() - PROCESS_STARTED_AT) / 1000),
    time: new Date().toISOString(),
  };

  if (!(await isInsider(request))) {
    // Ни запроса в базу, ни намёка на её состояние. Проверить, что процесс
    // жив, можно на /api/health/live — там то же самое и без условий.
    return NextResponse.json(
      { ok: true, ...base },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }

  const startedAt = Date.now();
  const db = await checkDatabase();
  const latencyMs = Date.now() - startedAt;

  if (!db.ok) {
    // Полный текст драйвера — только в лог: его видно в панели хостинга, а в
    // теле ответа он раскрыл бы хост базы (и имя пользователя при отказе прав).
    logWarn("health.database_down", { error: db.detail, kind: db.kind, latencyMs });
  }

  return NextResponse.json(
    {
      ok: db.ok,
      ...base,
      checks: {
        database: db.ok
          ? { ok: true, latencyMs }
          : { ok: false, latencyMs, kind: db.kind ?? "unknown" },
      },
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
