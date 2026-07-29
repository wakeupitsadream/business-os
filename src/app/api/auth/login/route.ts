import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { passwordConfigured, verifyOwnerPassword } from "@/core/auth/password";
import {
  clientIp,
  hitLoginAttempt,
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

  let password: string;
  try {
    // Пароль в теле запроса и остаётся здесь: ни в лог, ни в ответ он не попадает.
    password = bodySchema.parse(await request.json()).password;
  } catch {
    return fail("Введите пароль", 400);
  }

  if (!(await verifyOwnerPassword(password))) {
    logWarn("auth.login_failed", { ip, remaining: limit.remaining });
    return fail("Неверный пароль", 401);
  }

  resetLoginAttempts(ip);

  const store = await cookies();
  store.set(SESSION_COOKIE, await issueSessionToken(), sessionCookieOptions());

  logInfo("auth.login_ok", { ip });
  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
