/**
 * Liveness для HEALTHCHECK контейнера. Никаких внешних зависимостей — и
 * особенно НИКАКОЙ базы.
 *
 * Почему отдельный роут, а не `/api/health`. Проба идёт каждые 30 секунд, то
 * есть 2880 раз в сутки. Если она трогает базу, компьют Neon не простаивает
 * пять минут никогда и не засыпает вовсе: лимит бесплатного тарифа (100
 * CU-часов, общих на весь аккаунт) выбирается за две с половиной недели, и
 * вместе с этим приложением встаёт всё остальное, что живёт на том же Neon.
 *
 * Кэш внутри `/api/health` эту задачу не решал бы: запрос раз в N минут всё
 * равно каждый раз поднимает компьют на пять минут вперёд, поэтому экономит
 * кэш только при обращениях чаще, чем раз в пять минут. Компьют бережёт не он,
 * а то, что проба вообще не выполняется — здесь потому, что роут её не делает,
 * а в `/api/health` потому, что она закрыта авторизацией. Кэш там оставлен
 * как вежливость к обновляющему страницу владельцу, не как защита.
 *
 * Разделение честное и по смыслу: хостингу нужен ответ на вопрос «процесс жив»
 * (иначе он убьёт исправный контейнер из-за лежащей базы), а владельцу —
 * «система здорова». Это разные вопросы, и `/api/health` отвечает на второй.
 */

import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Тот же способ, что и в `/api/health`: BUILD_SHA от планировщика, иначе файл. */
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

export function GET(): NextResponse {
  return NextResponse.json(
    {
      ok: true,
      service: "business-os",
      gitSha: GIT_SHA,
      uptimeSec: Math.round((Date.now() - PROCESS_STARTED_AT) / 1000),
      time: new Date().toISOString(),
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
