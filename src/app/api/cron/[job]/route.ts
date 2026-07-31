/**
 * Диспетчер фоновых задач: `GET/POST /api/cron/<имя>` с заголовком
 * `Authorization: Bearer <CRON_SECRET>`.
 *
 * Роут открыт для middleware (у него своя авторизация по секрету), поэтому
 * проверка секрета здесь — единственный периметр. Если CRON_SECRET не задан,
 * роут отвечает 503, а НЕ пропускает вызов: незакрытый крон-эндпоинт снаружи
 * даёт любому желающему дёргать джобы приложения.
 */

import { NextResponse, type NextRequest } from "next/server";
import { bearerToken, secretsMatch } from "@/core/auth/bearer";
import { getCronHandler } from "@/core/cron/registry";
import { optionalEnv } from "@/core/env";
import { logError, logInfo, logWarn, startTimer } from "@/core/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Потолок на одну задачу. Дальше почти наверняка висящий внешний вызов. */
const JOB_TIMEOUT_MS = 5 * 60 * 1000;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Задача не уложилась в ${ms} мс`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function handle(
  request: NextRequest,
  ctx: { params: Promise<{ job: string }> },
): Promise<NextResponse> {
  const { job } = await ctx.params;

  const expected = optionalEnv("CRON_SECRET");
  if (!expected) {
    logError("cron.secret_missing", { job });
    return NextResponse.json(
      { ok: false, error: "Кроны отключены: не задана переменная окружения CRON_SECRET" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  if (!secretsMatch(bearerToken(request), expected)) {
    logWarn("cron.unauthorized", { job });
    return NextResponse.json(
      { ok: false, error: "Неверный секрет" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  const handler = getCronHandler(job);
  if (!handler) {
    logWarn("cron.unknown_job", { job });
    return NextResponse.json(
      { ok: false, error: `Неизвестная задача: ${job}` },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }

  const done = startTimer();
  try {
    const result = await withTimeout(handler(), JOB_TIMEOUT_MS);
    const ms = done();
    logInfo("cron.job_finished", { job, ok: result.ok, ms, detail: result.detail });
    return NextResponse.json(
      { ok: result.ok, job, ms, detail: result.detail },
      { status: result.ok ? 200 : 500, headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    // Исключение джобы наружу не выпускаем: планировщик получает внятный код,
    // а причина уходит в лог одной строкой.
    const ms = done();
    const error = e instanceof Error ? e.message : "неизвестная ошибка";
    logError("cron.job_failed", { job, ms, error });
    return NextResponse.json(
      { ok: false, job, ms, error },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ job: string }> },
): Promise<NextResponse> {
  return handle(request, ctx);
}

/** POST — чтобы задачу можно было дёрнуть внешним планировщиком (или руками). */
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ job: string }> },
): Promise<NextResponse> {
  return handle(request, ctx);
}
