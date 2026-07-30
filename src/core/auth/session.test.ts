import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  SESSION_REFRESH_AFTER_SEC,
  SESSION_TTL_SEC,
  authConfigured,
  issueSessionToken,
  needsRefresh,
  readSession,
  sessionCookieOptions,
  verifySessionToken,
} from "./session";

const SECRET = "тестовый-секрет-подписи-сессии-достаточной-длины";
const OTHER_SECRET = "совершенно-другой-секрет-подписи-сессии";

/** Повторяет вывод ключа из session.ts, чтобы подписать «чужой» токен вручную. */
async function keyFor(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function signWith(
  secret: string,
  claims: { sub?: string; iat: number; exp: number },
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub ?? "owner")
    .setIssuedAt(claims.iat)
    .setExpirationTime(claims.exp)
    .sign(await keyFor(secret));
}

beforeEach(() => {
  process.env.AUTH_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.AUTH_SECRET;
});

describe("issueSessionToken / readSession", () => {
  it("выпущенный токен проходит проверку и несёт минимальный payload", async () => {
    const token = await issueSessionToken();
    const claims = await readSession(token);

    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe("owner");
    expect(claims?.exp).toBe((claims?.iat ?? 0) + SESSION_TTL_SEC);
    expect(await verifySessionToken(token)).toBe(true);
  });

  it("токен, подписанный другим секретом, невалиден", async () => {
    const now = Math.floor(Date.now() / 1000);
    const foreign = await signWith(OTHER_SECRET, { iat: now, exp: now + SESSION_TTL_SEC });

    expect(await readSession(foreign)).toBeNull();
    expect(await verifySessionToken(foreign)).toBe(false);
  });

  it("свой токен перестаёт быть валидным после смены AUTH_SECRET", async () => {
    const token = await issueSessionToken();
    expect(await verifySessionToken(token)).toBe(true);

    process.env.AUTH_SECRET = OTHER_SECRET;
    expect(await verifySessionToken(token)).toBe(false);
  });

  it("просроченный токен невалиден", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await signWith(SECRET, { iat: now - SESSION_TTL_SEC - 60, exp: now - 60 });

    expect(await readSession(expired)).toBeNull();
  });

  it("чужой subject не принимается", async () => {
    const now = Math.floor(Date.now() / 1000);
    const alien = await signWith(SECRET, { sub: "guest", iat: now, exp: now + 3600 });

    expect(await readSession(alien)).toBeNull();
  });

  it("мусор и пустое значение не бросают, а дают null", async () => {
    expect(await readSession(undefined)).toBeNull();
    expect(await readSession("")).toBeNull();
    expect(await readSession("не.токен.вовсе")).toBeNull();
    expect(await verifySessionToken("aaa.bbb.ccc")).toBe(false);
  });

  it("без AUTH_SECRET выпуск падает, а проверка молча отвергает", async () => {
    delete process.env.AUTH_SECRET;

    expect(authConfigured()).toBe(false);
    await expect(issueSessionToken()).rejects.toThrow(/AUTH_SECRET/);
    expect(await readSession("что-угодно")).toBeNull();
  });
});

describe("needsRefresh", () => {
  const nowSec = 1_800_000_000;
  const nowMs = nowSec * 1000;

  it("свежая кука не продлевается", () => {
    expect(needsRefresh({ sub: "owner", iat: nowSec - 60, exp: nowSec + SESSION_TTL_SEC }, nowMs)).toBe(
      false,
    );
  });

  it("кука старше суток продлевается", () => {
    const iat = nowSec - SESSION_REFRESH_AFTER_SEC - 1;
    expect(needsRefresh({ sub: "owner", iat, exp: iat + SESSION_TTL_SEC }, nowMs)).toBe(true);
  });

  it("порог включительный", () => {
    const iat = nowSec - SESSION_REFRESH_AFTER_SEC;
    expect(needsRefresh({ sub: "owner", iat, exp: iat + SESSION_TTL_SEC }, nowMs)).toBe(true);
  });
});

describe("sessionCookieOptions", () => {
  it("кука httpOnly, lax, на весь сайт", () => {
    const options = sessionCookieOptions();

    expect(SESSION_COOKIE).toBe("bos_session");
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
    expect(options.maxAge).toBe(SESSION_TTL_SEC);
    // Вне прода Secure выключен — иначе локальный http-вход не работал бы.
    expect(options.secure).toBe(false);
  });

  it("maxAge=0 для удаления куки", () => {
    expect(sessionCookieOptions(0).maxAge).toBe(0);
  });
});
