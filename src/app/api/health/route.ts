/**
 * Диагностический health: «система здорова», а не «процесс жив».
 *
 * На вопрос «жив ли процесс» отвечает `/api/health/live` — он и стоит в
 * HEALTHCHECK контейнера. Здесь же живёт проверка базы, и с ней связаны два
 * ограничения, каждое из которых оплачено разбором.
 *
 * **Наружу не уходит ни хост, ни порт, ни имя пользователя БД.** Раньше в теле
 * лежал сырой текст ошибки Prisma, а он для Neon выглядит как
 * `Can't reach database server at ep-….eu-central-1.aws.neon.tech:5432` —
 * вендор, регион и конкретный endpoint. Шапка этого файла при этом утверждала
 * обратное («ни хостов… здесь нет») — худший вид комментария. Теперь в теле
 * только категория (`timeout | unreachable | auth | unknown`), полный текст
 * уходит в `logWarn`, который виден в панели хостинга.
 *
 * **В базу ходим только для авторизованного.** Роут публичный (middleware
 * пускает его без сессии), и `SELECT 1` на каждый запрос означал, что любой
 * желающий может держать компьют Neon включённым: лимит на аккаунте общий, и
 * вместе с Business OS встало бы всё остальное на том же Neon. Кэш эту дыру
 * не закрывает — запрос раз в минуту всё равно не даёт компьюту заснуть.
 * Поэтому проба идёт только по `Bearer CRON_SECRET` или по куке владельца;
 * анонимный ответ честно говорит, что базу не проверяли.
 *
 * Ответ всегда 200 — как и раньше. Урок Agentus: health, отдающий 503 при
 * недоступной БД, ломает деплой, потому что хостинг считает новый контейнер
 * битым и откатывается на старый образ, хотя код исправен.
 */

import { readFileSync } from "node:fs";
import { NextResponse, type NextRequest } from "next/server";
import { hasCronSecret } from "@/core/auth/bearer";
import { SESSION_COOKIE, verifySessionToken } from "@/core/auth/session";
import { probeDatabase } from "./probe";

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

async function authorized(request: NextRequest): Promise<boolean> {
  if (hasCronSecret(request)) return true;
  return verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value ?? "");
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const database = (await authorized(request))
    ? await probeDatabase()
    : {
        checked: false as const,
        hint: "проверка базы — по Bearer CRON_SECRET или из сессии владельца",
      };

  return NextResponse.json(
    {
      // `ok` — «всё, что мы проверяли, в порядке». Для анонима база не
      // проверялась, и выдавать её состояние за проверенное нельзя.
      ok: database.checked ? database.ok : true,
      service: "business-os",
      gitSha: GIT_SHA,
      uptimeSec: Math.round((Date.now() - PROCESS_STARTED_AT) / 1000),
      checks: { database },
      time: new Date().toISOString(),
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
