/**
 * Приём вебхука Telegram.
 *
 * Два железных правила этого роута:
 *  1. Всегда 200 (кроме неверного секрета). Любой не-200 заставляет Telegram
 *     ретраить апдейт снова и снова — очередь встаёт, ответы приходят с
 *     задержкой в минуты, а в чат сыплются дубли.
 *  2. Отвечать быстро. Генерация ответа занимает 10+ секунд, поэтому она
 *     идёт ПОСЛЕ ответа, фоновой задачей (контейнер живёт постоянно, это не
 *     serverless — фон не будет убит).
 */

import { NextResponse } from "next/server";
import { optionalEnv } from "@/core/env";
import { logError, logInfo, logWarn } from "@/core/observability/logger";
import { ownerChatId } from "@/core/telegram/bot";
import { claimUpdate } from "@/core/telegram/dedup";
import { handleUpdate } from "@/core/telegram/handle";
import { updateChatId, type TelegramUpdate } from "@/core/telegram/update";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OK = () => NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });

export async function POST(request: Request): Promise<NextResponse> {
  const expectedSecret = optionalEnv("TELEGRAM_WEBHOOK_SECRET");
  const gotSecret = request.headers.get("x-telegram-bot-api-secret-token");

  if (expectedSecret) {
    if (gotSecret !== expectedSecret) {
      logWarn("telegram.webhook_bad_secret", {});
      return NextResponse.json({ ok: false }, { status: 401 });
    }
  } else {
    // Работать без секрета можно (защищает ещё и allowlist по chat_id), но это
    // всегда конфигурационная ошибка — пусть она видна в логах.
    logWarn("telegram.webhook_secret_missing", {});
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    logWarn("telegram.webhook_bad_json", {});
    return OK();
  }

  const updateId = update.update_id;
  if (typeof updateId !== "number") {
    logWarn("telegram.webhook_no_update_id", {});
    return OK();
  }

  // Allowlist: это личный бот одного человека, всё чужое молча дропаем.
  const owner = ownerChatId();
  const chatId = updateChatId(update);
  if (owner === null || chatId !== owner) {
    logWarn("telegram.webhook_foreign_chat", { chatId: chatId ?? "нет", configured: owner !== null });
    return OK();
  }

  if (!(await claimUpdate(updateId))) {
    logInfo("telegram.webhook_duplicate", { updateId });
    return OK();
  }

  // Фоновая обработка: catch обязателен — unhandled rejection роняет процесс.
  void handleUpdate(update).catch((error: unknown) => {
    logError("telegram.background_failed", {
      updateId,
      error: error instanceof Error ? error.message : "unknown",
    });
  });

  return OK();
}

/** GET удобен для ручной проверки, что роут вообще жив и не закрыт middleware. */
export function GET(): NextResponse {
  return NextResponse.json({ ok: true, service: "telegram-webhook" });
}
