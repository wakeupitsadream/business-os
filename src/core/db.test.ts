import { describe, expect, it } from "vitest";
import { classifyDbFailure, describeDbFailure } from "./db";

/**
 * Разбор причины отказа базы.
 *
 * Существует ради того, чтобы наружу уходила категория, а не текст драйвера:
 * в тексте Prisma лежит хост базы, а при неверном пароле ещё и имя
 * пользователя. Категория обязана быть достаточно точной, чтобы по ней можно
 * было понять, куда смотреть, — иначе владелец полезет в сырые логи и смысл
 * разделения потеряется.
 */

describe("категория отказа", () => {
  it("сеть до базы не дошла", () => {
    expect(classifyDbFailure("Can't reach database server at `ep-x.neon.tech:5432`")).toBe(
      "unreachable",
    );
    expect(classifyDbFailure("Error: connect ECONNREFUSED 10.0.0.1:5432")).toBe("unreachable");
    expect(classifyDbFailure("getaddrinfo ENOTFOUND ep-x.neon.tech")).toBe("unreachable");
    expect(classifyDbFailure("P1001: Can't reach database server")).toBe("unreachable");
  });

  it("наш собственный таймаут — отдельная категория", () => {
    // Компьют Neon просыпается из сна: это не «база лежит», а «не успела».
    expect(classifyDbFailure("db health timeout")).toBe("timeout");
  });

  it("отказ доступа не выдаётся за сетевой сбой", () => {
    // Разница важна: при отказе прав перезапуск не поможет, менять надо
    // строку подключения.
    expect(
      classifyDbFailure(
        "P1000: Authentication failed against database server, the provided database credentials for `neondb_owner` are not valid",
      ),
    ).toBe("auth");
    expect(classifyDbFailure("password authentication failed for user")).toBe("auth");
  });

  it("незнакомое остаётся незнакомым, а не приписывается сети", () => {
    expect(classifyDbFailure("что-то совсем другое")).toBe("unknown");
  });
});

describe("формулировка для владельца", () => {
  it("не содержит ни хоста, ни имени пользователя", () => {
    for (const kind of ["unreachable", "timeout", "auth", "unknown"] as const) {
      const text = describeDbFailure(kind);
      expect(text).not.toMatch(/neon|5432|prisma|@/i);
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("на отсутствующую категорию отвечает нейтрально", () => {
    expect(describeDbFailure(undefined)).toBe("недоступна");
  });
});
