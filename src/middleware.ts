/**
 * Периметр приложения: режим техработ, проверка сессии, скользящее продление.
 *
 * Исполняется в Edge-рантайме — здесь НЕЛЬЗЯ трогать prisma и @node-rs/argon2.
 * Режим техработ намеренно не обращается ни к чему внешнему: он должен
 * работать при лежащей БД, ради чего его и включают (урок Agentus: страницу
 * техработ пришлось поднимать в момент, когда приложение не могло даже
 * подключиться к постгресу).
 */

import { NextResponse, type NextRequest } from "next/server";
import { envFlag } from "@/core/env";
import {
  SESSION_COOKIE,
  issueSessionToken,
  needsRefresh,
  readSession,
  sessionCookieOptions,
} from "@/core/auth/session";

/** Пути, доступные без сессии. У вебхука и кронов своя авторизация по секрету. */
const PUBLIC_EXACT = new Set(["/login", "/api/auth/login", "/api/health", "/api/telegram/webhook"]);
const PUBLIC_PREFIX = ["/api/cron/", "/api/health/"];

function isPublic(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PREFIX.some((p) => pathname.startsWith(p));
}

const MAINTENANCE_HTML = `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Технические работы — BUSINESS OS</title>
<style>
  html,body{height:100%;margin:0}
  body{background:#0A0A0A;color:#E8E8E8;display:flex;align-items:center;justify-content:center;
       font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:24px}
  .card{max-width:420px;border:1px solid #262626;background:#121212;border-radius:12px;padding:32px}
  h1{margin:0 0 12px;font-size:15px;letter-spacing:.18em;color:#FF6B00;text-transform:uppercase}
  p{margin:0;font-size:14px;line-height:1.6;color:#8A8A8A}
</style></head>
<body><div class="card">
<h1>Технические работы</h1>
<p>Business OS временно недоступен — идёт обслуживание. Зайдите чуть позже.</p>
</div></body></html>`;

function maintenanceResponse(): NextResponse {
  return new NextResponse(MAINTENANCE_HTML, {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": "600",
    },
  });
}

function unauthorized(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { ok: false, error: "Требуется вход" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  const target = `${pathname}${search}`;
  if (target !== "/") url.searchParams.set("next", target);
  return NextResponse.redirect(url);
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  if (envFlag("MAINTENANCE_MODE")) {
    // Health оставляем живым: по нему платформа и владелец видят, что контейнер
    // поднят, а не упал.
    if (pathname === "/api/health" || pathname.startsWith("/api/health/")) {
      return NextResponse.next();
    }
    return maintenanceResponse();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const claims = await readSession(token);

  if (pathname === "/login") {
    if (claims) return NextResponse.redirect(new URL("/", request.url));
    return NextResponse.next();
  }

  if (isPublic(pathname)) return NextResponse.next();

  if (!claims) return unauthorized(request);

  const response = NextResponse.next();

  // Скользящий TTL: активный владелец не должен логиниться заново раз в месяц.
  if (needsRefresh(claims)) {
    try {
      response.cookies.set(SESSION_COOKIE, await issueSessionToken(), sessionCookieOptions());
    } catch {
      // Продление — не критичный путь: если секрет вдруг пропал, действующая
      // кука ещё валидна, ронять запрос из-за этого нельзя.
    }
  }

  return response;
}

export const config = {
  // Статика Next и иконки мимо middleware: на них проверять сессию незачем,
  // а лишний вызов на каждый чанк — заметная задержка холодного открытия.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|apple-icon.png|icon.png|manifest.webmanifest|site.webmanifest|robots.txt|sitemap.xml|icons/).*)",
  ],
};
