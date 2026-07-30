import { describe, it, expect } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
import { classifyMigrateFailure, looksPooled } from "../../../scripts/migrate-error-kind.mjs";

/**
 * От этой классификации зависит, поднимется ли контейнер и на какой схеме он
 * будет работать. Ошибка здесь не проявляется как падение: контейнер стартует,
 * /api/health отвечает 200 и ok:true, а таблиц в базе нет — и каждый запрос
 * падает на «relation does not exist». Поэтому проверяем поимённо, дословными
 * сообщениями Prisma.
 */

const classify = classifyMigrateFailure as (out: string) => "unreachable" | "pooler" | "fatal";
const pooled = looksPooled as (s: string) => boolean;

describe("сетевая недоступность → старт продолжается", () => {
  it("P1001: до сервера не достучаться", () => {
    expect(classify("Error: P1001: Can't reach database server at `ep-x.neon.tech:5432`")).toBe(
      "unreachable",
    );
  });

  it("отказ соединения и неизвестный хост", () => {
    expect(classify("connect ECONNREFUSED 10.0.0.1:5432")).toBe("unreachable");
    expect(classify("getaddrinfo ENOTFOUND ep-x.neon.tech")).toBe("unreachable");
  });

  it("сервер закрыл соединение", () => {
    expect(classify("server closed the connection unexpectedly")).toBe("unreachable");
  });
});

describe("миграции через пул → останавливаемся с объяснением", () => {
  it("таймаут advisory lock — это пул, а не блип базы", () => {
    // Ровно та строка, которую отдаёт Prisma при миграции через PgBouncer.
    // Она содержит «Timed out», и раньше именно поэтому проходила как «база
    // моргнула»: контейнер поднимался без единой таблицы.
    const out =
      "Error: Timed out trying to acquire a postgres advisory lock (SELECT pg_advisory_lock(72707369)). Elapsed: 10000ms.";
    expect(classify(out)).toBe("pooler");
    expect(classify(out)).not.toBe("unreachable");
  });
});

describe("ошибки конфигурации и схемы → останавливаемся", () => {
  it("неверный пароль — не повод стартовать без схемы", () => {
    // Само не пройдёт: первый деплой на чистую базу навсегда остался бы без
    // таблиц, повторяя это решение на каждом рестарте.
    expect(classify("Error: P1000: Authentication failed against database server")).toBe("fatal");
    expect(classify("password authentication failed for user \"owner\"")).toBe("fatal");
  });

  it("нехватка прав", () => {
    expect(classify("ERROR: permission denied for schema public")).toBe("fatal");
  });

  it("дрейф схемы и плохой SQL", () => {
    expect(classify('ERROR: relation "Conversation" does not exist')).toBe("fatal");
    expect(classify("Error: P3006 migration failed to apply cleanly")).toBe("fatal");
  });

  it("пустой вывод не считается блипом", () => {
    expect(classify("")).toBe("fatal");
  });
});

describe("looksPooled", () => {
  it("узнаёт пул Neon по хосту и по параметру", () => {
    expect(pooled("postgresql://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/db")).toBe(true);
    expect(pooled("postgresql://u:p@ep-x.neon.tech/db?pgbouncer=true")).toBe(true);
  });

  it("прямую строку не трогает", () => {
    expect(pooled("postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/db?sslmode=require")).toBe(
      false,
    );
  });
});
