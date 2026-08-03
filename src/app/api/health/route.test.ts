import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Диагностический health.
 *
 * Два свойства, ради которых он и переделан. Первое: наружу не уходит текст
 * драйвера — у Prisma в нём хост базы, а при неверном пароле ещё и имя
 * пользователя, причём появляется он ровно в инцидент, когда health дёргают
 * все подряд. Второе: посторонний не должен вызывать поход в базу — каждый
 * такой поход будит компьют Neon на пять минут, а лимит общий на весь аккаунт.
 */

const checkDatabase = vi.fn(async () => ({ ok: true }) as Record<string, unknown>);
const isAuthenticated = vi.fn(async () => false);

vi.mock("@/core/db", () => ({
  checkDatabase: (...a: unknown[]) => checkDatabase(...(a as [])),
}));

vi.mock("@/core/auth/session", () => ({
  isAuthenticated: () => isAuthenticated(),
}));

const { GET } = await import("./route");

/** Строка, которую Prisma отдаёт при недоступном Neon. */
const PRISMA_LEAK =
  "\nInvalid `prisma.$queryRaw()` invocation:\n\n\n" +
  "Can't reach database server at `ep-still-forest-ag71x3x8.c-2.eu-central-1.aws.neon.tech:5432`";

function request(headers: Record<string, string> = {}) {
  return new NextRequest("https://app.example.com/api/health", { headers });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  checkDatabase.mockReset();
  isAuthenticated.mockReset();
  checkDatabase.mockResolvedValue({ ok: true });
  isAuthenticated.mockResolvedValue(false);
});

describe("посторонний", () => {
  it("не вызывает похода в базу", async () => {
    await GET(request());
    expect(checkDatabase).not.toHaveBeenCalled();
  });

  it("получает 200 и подтверждение, что процесс жив", async () => {
    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.gitSha).toBeTruthy();
  });

  it("не узнаёт состояние базы вовсе", async () => {
    const body = await (await GET(request())).json();
    expect(body.checks).toBeUndefined();
  });
});

describe("свой по ключу кронов", () => {
  it("получает проверку базы", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const res = await GET(request({ authorization: "Bearer s3cret" }));
    const body = await res.json();

    expect(checkDatabase).toHaveBeenCalledTimes(1);
    expect(body.checks.database.ok).toBe(true);
  });

  it("чужой ключ своим не делает", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    await GET(request({ authorization: "Bearer wrong" }));
    expect(checkDatabase).not.toHaveBeenCalled();
  });

  it("при пустом CRON_SECRET заголовок не открывает дверь", async () => {
    // Иначе на стенде без секрета health открыт кому угодно.
    await GET(request({ authorization: "Bearer " }));
    expect(checkDatabase).not.toHaveBeenCalled();
  });
});

describe("владелец по сессии", () => {
  it("получает проверку базы", async () => {
    isAuthenticated.mockResolvedValue(true);
    const body = await (await GET(request())).json();
    expect(body.checks.database.ok).toBe(true);
  });
});

describe("лежащая база", () => {
  beforeEach(() => {
    isAuthenticated.mockResolvedValue(true);
    checkDatabase.mockResolvedValue({ ok: false, kind: "unreachable", detail: PRISMA_LEAK });
  });

  it("в теле только категория, без текста драйвера", async () => {
    const body = await (await GET(request())).json();
    expect(body.checks.database.kind).toBe("unreachable");
    expect(body.checks.database.error).toBeUndefined();
  });

  it("хост базы наружу не уходит ни в каком виде", async () => {
    // Главная проверка этого файла: сравнивается весь ответ целиком, потому
    // что утечь строка может из любого поля, а не только из того, где она была.
    const text = JSON.stringify(await (await GET(request())).json());
    expect(text).not.toContain("neon.tech");
    expect(text).not.toContain(":5432");
    expect(text).not.toContain("prisma");
    expect(text).not.toContain("ep-still-forest");
  });

  it("статус остаётся 200 — иначе хостинг откатит исправный контейнер", async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(false);
  });
});
