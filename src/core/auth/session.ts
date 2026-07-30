/**
 * Сессия владельца: подписанный JWT в httpOnly-куке.
 *
 * Этот модуль обязан оставаться Edge-совместимым: его импортирует
 * `src/middleware.ts`, а middleware в Next.js исполняется в Edge-рантайме, где
 * нет ни prisma, ни нативного @node-rs/argon2. Поэтому здесь только `jose` и
 * WebCrypto. Работа с `next/headers` (функция `isAuthenticated`) вынесена в
 * динамический импорт — модуль не должен тянуть серверные API в Edge-граф.
 *
 * Пользователь один, ролей нет, отзыва сессий нет — payload минимальный
 * {sub, iat, exp}. Хранилище сессий не нужно: подпись и есть проверка.
 */

// Импорт из точечных подпутей, а не из барреля `jose`: баррель тянет ещё и
// JWE-ветку, которой мы не пользуемся, а она требует DecompressionStream —
// его нет в Edge-рантайме. Next.js предупреждал об этом на каждой сборке, и
// такое предупреждение легко перестать замечать ровно до того дня, когда за
// ним окажется настоящая поломка. Заодно бандл middleware стал легче.
import { SignJWT } from "jose/jwt/sign";
import { jwtVerify } from "jose/jwt/verify";
import { isProduction, optionalEnv } from "@/core/env";

export const SESSION_COOKIE = "bos_session";

/** Срок жизни сессии — 30 дней. */
export const SESSION_TTL_SEC = 60 * 60 * 24 * 30;

/**
 * Порог скользящего продления: куку перевыпускаем, если она старше суток.
 * Перевыпуск на каждом запросе означал бы Set-Cookie в каждом ответе —
 * лишний вес и мусор в логах прокси.
 */
export const SESSION_REFRESH_AFTER_SEC = 60 * 60 * 24;

const ALG = "HS256";
const SUBJECT = "owner";

export interface SessionClaims {
  sub: string;
  /** Секунды epoch. */
  iat: number;
  /** Секунды epoch. */
  exp: number;
}

/** Настроена ли подпись сессии. Без секрета вход невозможен. */
export function authConfigured(): boolean {
  return Boolean(optionalEnv("AUTH_SECRET"));
}

const keyCache = new Map<string, Promise<CryptoKey>>();

/**
 * Ключ HS256 выводим как SHA-256 от AUTH_SECRET, а не берём байты секрета
 * напрямую: jose требует для HS256 ровно 256-битный ключ, и короткий секрет
 * из .env иначе роняет вход с невнятной ошибкой уже в проде.
 */
async function signingKey(): Promise<CryptoKey | null> {
  const secret = optionalEnv("AUTH_SECRET");
  if (!secret) return null;

  const cached = keyCache.get(secret);
  if (cached) return cached;

  const promise = (async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    return crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
  })();

  keyCache.set(secret, promise);
  return promise;
}

/** Выпуск нового токена сессии. Бросает, если AUTH_SECRET не задан. */
export async function issueSessionToken(): Promise<string> {
  const key = await signingKey();
  if (!key) throw new Error("Не задана обязательная переменная окружения AUTH_SECRET");

  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG })
    .setSubject(SUBJECT)
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_TTL_SEC)
    .sign(key);
}

/**
 * Разбор и проверка токена. Возвращает claims или null — никогда не бросает:
 * middleware не имеет права отвечать 500 из-за битой куки.
 */
export async function readSession(token: string | undefined | null): Promise<SessionClaims | null> {
  if (!token) return null;

  const key = await signingKey();
  if (!key) return null;

  try {
    const { payload } = await jwtVerify(token, key, { algorithms: [ALG] });
    if (payload.sub !== SUBJECT) return null;
    if (typeof payload.iat !== "number" || typeof payload.exp !== "number") return null;
    return { sub: payload.sub, iat: payload.iat, exp: payload.exp };
  } catch {
    return null;
  }
}

export async function verifySessionToken(token: string): Promise<boolean> {
  return (await readSession(token)) !== null;
}

/** Пора ли продлить сессию (скользящий TTL). */
export function needsRefresh(claims: SessionClaims, nowMs: number = Date.now()): boolean {
  const nowSec = Math.floor(nowMs / 1000);
  return nowSec - claims.iat >= SESSION_REFRESH_AFTER_SEC;
}

export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
}

export function sessionCookieOptions(maxAge: number = SESSION_TTL_SEC): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    // В dev по http кука с Secure не долетит — тогда логин выглядел бы «молча
    // не сработавшим».
    secure: isProduction,
    path: "/",
    maxAge,
  };
}

/**
 * Проверка сессии в серверном компоненте или route handler.
 * `next/headers` импортируем динамически — см. шапку файла.
 */
export async function isAuthenticated(): Promise<boolean> {
  const { cookies } = await import("next/headers");
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value ?? "");
}
