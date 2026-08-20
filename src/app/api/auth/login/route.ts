import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { passwordConfigured, verifyOwnerPassword } from "@/core/auth/password";
import {
  clientIp,
  globalLoginState,
  hitLoginAttempt,
  noteFailedLogin,
  rateLimitMessage,
  resetLoginAttempts,
} from "@/core/auth/rate-limit";
import {
  SESSION_COOKIE,
  authConfigured,
  issueSessionToken,
  sessionCookieOptions,
} from "@/core/auth/session";
import { logInfo, logWarn } from "@/core/observability/logger";
import { alertOwner } from "@/core/observability/alerts";

// argon2 — нативный модуль, Edge его не потянет.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ password: z.string().min(1).max(512) });

function fail(message: string, status: number, headers?: Record<string, string>) {
  return NextResponse.json({ ok: false, error: message }, { status, headers });
}

export async function POST(request: Request): Promise<NextResponse> {
  const ip = clientIp(request.headers);

  if (!authConfigured() || !passwordConfigured()) {
    logWarn("auth.login_not_configured", {
      authSecret: authConfigured(),
      passwordHash: passwordConfigured(),
    });
    return fail("Вход не настроен: не заданы AUTH_SECRET и/или OWNER_PASSWORD_HASH", 503);
  }

  const limit = hitLoginAttempt(ip);
  if (!limit.allowed) {
    logWarn("auth.login_rate_limited", { ip });
    return fail(rateLimitMessage(limit.retryAfterSec), 429, {
      "retry-after": String(limit.retryAfterSec),
    });
  }

  // Общий потолок неудач: лимит на IP обходится ботнетом, по пять попыток с
  // тысячи адресов. Тревога важнее самой блокировки — о переборе владелец
  // должен узнать, а не обнаружить его через неделю в логах. Дедуп тревог
  // не даст этому превратиться в поток.
  const global = globalLoginState();
  if (global.blocked) {
    logWarn("auth.login_globally_blocked", { ip, failures: global.failures });
    void alertOwner(
      "login_bruteforce",
      `Неудачных входов за 15 минут: ${global.failures}, с разных адресов. Вход временно закрыт для всех; ваша сессия по куке работает.`,
    );
    return fail(rateLimitMessage(global.retryAfterSec), 429, {
      "retry-after": String(global.retryAfterSec),
    });
  }

  let password: string;
  try {
    // Пароль в теле запроса и остаётся здесь: ни в лог, ни в ответ он не попадает.
    password = bodySchema.parse(await request.json()).password;
  } catch {
    return fail("Введите пароль", 400);
  }

  if (!(await verifyOwnerPassword(password))) {
    noteFailedLogin();
    logWarn("auth.login_failed", { ip, remaining: limit.remaining });
    return fail("Неверный пароль", 401);
  }

  resetLoginAttempts(ip);

  const store = await cookies();
  store.set(SESSION_COOKIE, await issueSessionToken(), sessionCookieOptions());

  logInfo("auth.login_ok", { ip });
  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
