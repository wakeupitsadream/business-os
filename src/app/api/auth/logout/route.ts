import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions } from "@/core/auth/session";
import { logInfo } from "@/core/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  const store = await cookies();
  // Перезаписываем куку пустым значением с maxAge=0, а не только delete():
  // так браузер гарантированно затирает значение при совпадающих path/secure.
  store.set(SESSION_COOKIE, "", sessionCookieOptions(0));

  logInfo("auth.logout");
  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
