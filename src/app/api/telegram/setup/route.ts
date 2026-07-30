/**
 * Управление вебхуком Telegram: POST ставит, GET показывает текущее состояние.
 *
 * Роут закрыт сессией владельца (middleware + повторная проверка здесь):
 * setWebhook умеет увести весь трафик бота на чужой адрес.
 */

import { NextResponse } from "next/server";
import { isAuthenticated } from "@/core/auth/session";
import { appUrl, optionalEnv } from "@/core/env";
import { logInfo, logWarn } from "@/core/observability/logger";
import { tgConfigured, tgGetWebhookInfo, tgSetWebhook, telegramWebhookBase } from "@/core/telegram/bot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function webhookUrl(): string {
  return `${telegramWebhookBase(appUrl())}/api/telegram/webhook`;
}

async function guard(): Promise<NextResponse | null> {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ ok: false, error: "Требуется вход" }, { status: 401 });
  }
  if (!tgConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Telegram не настроен: не задан TELEGRAM_BOT_TOKEN" },
      { status: 503 },
    );
  }
  return null;
}

export async function POST(): Promise<NextResponse> {
  const denied = await guard();
  if (denied) return denied;

  const secret = optionalEnv("TELEGRAM_WEBHOOK_SECRET");
  if (!secret) logWarn("telegram.setup_without_secret", {});

  const url = webhookUrl();
  const result = await tgSetWebhook(url, secret);

  logInfo("telegram.setup_done", { url, ok: result.ok });
  return NextResponse.json(
    {
      ok: result.ok,
      url,
      // Владельцу важно видеть, что вебхук встал на Worker, а не на прод
      // напрямую: прямая доставка в РФ ретраится минутами.
      viaProxy: Boolean(optionalEnv("TELEGRAM_WEBHOOK_BASE")),
      secretSet: Boolean(secret),
      telegram: result.response,
      ...(result.ok ? {} : { error: result.description ?? "Telegram отклонил setWebhook" }),
    },
    { status: result.ok ? 200 : 502, headers: { "cache-control": "no-store" } },
  );
}

export async function GET(): Promise<NextResponse> {
  const denied = await guard();
  if (denied) return denied;

  const info = await tgGetWebhookInfo();
  return NextResponse.json(
    {
      ok: info.ok,
      expectedUrl: webhookUrl(),
      telegram: info.data,
      ...(info.ok ? {} : { error: info.description ?? "Telegram не ответил" }),
    },
    { status: info.ok ? 200 : 502, headers: { "cache-control": "no-store" } },
  );
}
