import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Две вещи, которые публичный health обязан НЕ делать.
 *
 * 1. Не называть базу. Сырой текст ошибки Prisma содержит хост, порт и — при
 *    неудачной аутентификации — имя пользователя БД. У Neon это ещё и вендор с
 *    регионом. Дефект срабатывает ровно в инцидент: база лежит, health дёргают
 *    все, включая сканеры.
 * 2. Не ходить в базу за анонима. Лимит компьюта на аккаунте Neon общий; роут,
 *    делающий `SELECT 1` каждому встречному, позволяет любому желающему
 *    выкачать его в цикле и уронить заодно всё остальное на том же аккаунте.
 *
 * Проверяется по факту: тело ответа сериализуется и в нём ищутся подстроки из
 * настоящего сообщения Prisma.
 */

const NEON_ERROR =
  "Can't reach database server at `ep-quiet-firefly-a1b2c3d4-pooler.eu-central-1.aws.neon.tech:5432`. " +
  "Please make sure your database server is running at `ep-quiet-firefly-a1b2c3d4-pooler.eu-central-1.aws.neon.tech:5432`.";

const checkDatabase = vi.fn();
const logWarn = vi.fn();

vi.mock("@/core/db", () => ({ checkDatabase: (...a: unknown[]) => checkDatabase(...a) }));
vi.mock("@/core/observability/logger", () => ({
  logWarn: (...a: unknown[]) => logWarn(...a),
  logInfo: () => {},
  logError: () => {},
}));

const { GET } = await import("./route");
const { resetHealthProbeCache } = await import("./probe");

const SECRET = "cron-secret-for-tests";

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3000/api/health", { headers });
}

beforeEach(() => {
  resetHealthProbeCache();
  checkDatabase.mockReset();
  logWarn.mockReset();
  process.env.CRON_SECRET = SECRET;
  // Без AUTH_SECRET подпись сессии невозможна — кука не пройдёт проверку, что
  // здесь и нужно: авторизуемся секретом крона.
  delete process.env.AUTH_SECRET;
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe("публичный /api/health", () => {
  it("не отдаёт хост, порт и текст ошибки базы", async () => {
    checkDatabase.mockResolvedValue({
      ok: false,
      reason: "unreachable",
      detail: NEON_ERROR,
    });
    const res = await GET(request({ authorization: `Bearer ${SECRET}` }));
    const body = JSON.stringify(await res.json());

    expect(res.status).toBe(200);
    for (const secret of ["neon.tech", ":5432", "ep-quiet-firefly", "Can't reach"]) {
      expect(body).not.toContain(secret);
    }
    // Категория остаётся — иначе роут перестаёт быть диагностическим.
    expect(body).toContain("unreachable");
  });

  it("полный текст ошибки уходит в лог, а не в ответ", async () => {
    checkDatabase.mockResolvedValue({ ok: false, reason: "auth", detail: NEON_ERROR });
    await GET(request({ authorization: `Bearer ${SECRET}` }));

    expect(logWarn).toHaveBeenCalledWith(
      "health.database_down",
      expect.objectContaining({ error: NEON_ERROR, reason: "auth" }),
    );
  });

  it("анонимный запрос не трогает базу вовсе", async () => {
    checkDatabase.mockResolvedValue({ ok: true });
    const res = await GET(request());
    const body = await res.json();

    expect(checkDatabase).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(body.checks.database.checked).toBe(false);
    // Аноним не проверял базу — значит и объявлять её здоровой не может.
    expect(body.checks.database.ok).toBeUndefined();
  });

  it("неверный секрет — тоже аноним", async () => {
    checkDatabase.mockResolvedValue({ ok: true });
    await GET(request({ authorization: "Bearer wrong-secret-value" }));
    expect(checkDatabase).not.toHaveBeenCalled();
  });

  it("незаданный CRON_SECRET не открывает пробу всем подряд", async () => {
    delete process.env.CRON_SECRET;
    checkDatabase.mockResolvedValue({ ok: true });
    await GET(request({ authorization: "Bearer " }));
    expect(checkDatabase).not.toHaveBeenCalled();
  });

  it("подряд идущие проверки не множат походы в базу", async () => {
    checkDatabase.mockResolvedValue({ ok: true });

    for (let i = 0; i < 5; i += 1) {
      await GET(request({ authorization: `Bearer ${SECRET}` }));
    }
    expect(checkDatabase).toHaveBeenCalledTimes(1);
  });
});
