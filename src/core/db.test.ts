import { describe, expect, it } from "vitest";
import { classifyDbFailure } from "./db";

/**
 * Классификация отказов базы.
 *
 * Тексты сообщений здесь не выдуманы: они сняты с настоящей Prisma 6.19.3,
 * запущенной против недоступного порта. Это важно, потому что первая версия
 * классификатора читала только код ошибки — а у ошибки из ленивого `$queryRaw`
 * и `code`, и `errorCode` равны `undefined`, и в «unknown» уходил ровно самый
 * частый случай: базы не видно. Пока такой тест не написан, дефект незаметен:
 * роут отвечает 200, поле есть, значение выглядит правдоподобно.
 */

/** Ровно то, что отдаёт Prisma при недоступном сервере (снято с 6.19.3). */
const UNREACHABLE = `
Invalid \`prisma.$queryRaw()\` invocation:


Can't reach database server at \`ep-quiet-firefly-a1b2.eu-central-1.aws.neon.tech:5432\`

Please make sure your database server is running at \`ep-quiet-firefly-a1b2.eu-central-1.aws.neon.tech:5432\`.`;

/** Инициализационная ошибка Prisma: код есть в типе, но на деле undefined. */
function initError(message: string): Error {
  const e = new Error(message);
  e.name = "PrismaClientInitializationError";
  Object.assign(e, { clientVersion: "6.19.3", errorCode: undefined });
  return e;
}

describe("категория отказа базы", () => {
  it("недоступный сервер — unreachable, даже когда кода нет вовсе", () => {
    expect(classifyDbFailure(initError(UNREACHABLE))).toBe("unreachable");
  });

  it("отказ аутентификации — auth", () => {
    const message =
      "Authentication failed against database server, the provided database " +
      "credentials for `owner` are not valid.";
    expect(classifyDbFailure(initError(message))).toBe("auth");
  });

  it("наша собственная гонка с таймером — timeout", () => {
    expect(classifyDbFailure(new Error("db health timeout"))).toBe("timeout");
  });

  it("исчерпанный пул — timeout, здесь код есть", () => {
    const e = Object.assign(new Error("Timed out fetching a new connection"), { code: "P2024" });
    expect(classifyDbFailure(e)).toBe("timeout");
  });

  it("код читается и из code, и из errorCode", () => {
    expect(classifyDbFailure(Object.assign(new Error("x"), { code: "P1001" }))).toBe("unreachable");
    expect(classifyDbFailure(Object.assign(new Error("x"), { errorCode: "P1000" }))).toBe("auth");
  });

  it("незнакомая ошибка — честное unknown, а не выдумка", () => {
    expect(classifyDbFailure(new Error("что-то совсем другое"))).toBe("unknown");
    expect(classifyDbFailure("не ошибка вовсе")).toBe("unknown");
    expect(classifyDbFailure(undefined)).toBe("unknown");
  });

  it("категория не тащит за собой ни хост, ни порт", () => {
    // Смысл всей затеи: что бы ни пришло, наружу уходит одно из четырёх слов.
    const reason = classifyDbFailure(initError(UNREACHABLE));
    expect(["timeout", "unreachable", "auth", "unknown"]).toContain(reason);
    expect(reason).not.toContain("neon.tech");
  });
});
