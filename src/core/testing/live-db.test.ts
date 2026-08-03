import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assertDisposableDatabase, databaseHost, isDisposableDatabase } from "./live-db";

/**
 * Тесты защиты, которая стоит перед `deleteMany({})` живых тестов.
 *
 * Проверяется одно свойство и в обе стороны: боевая база не должна пройти
 * никогда, а местная — должна проходить всегда, иначе защиту снимут первым же
 * коммитом как мешающую работать.
 */

const NEON = "postgresql://u:p@ep-still-forest-ag71x3x8-pooler.c-2.eu-central-1.aws.neon.tech/db?sslmode=require";
const LOCAL = "postgresql://u:p@localhost:5432/bosdev";

describe("что считается расходной базой", () => {
  it("местная проходит", () => {
    expect(isDisposableDatabase(LOCAL)).toBe(true);
    expect(isDisposableDatabase("postgresql://u:p@127.0.0.1:5432/bosdev")).toBe(true);
  });

  it("хост в docker-сети тоже местный", () => {
    expect(isDisposableDatabase("postgresql://u:p@db:5432/bosdev")).toBe(true);
  });

  it("Neon не проходит", () => {
    expect(isDisposableDatabase(NEON)).toBe(false);
  });

  it("любой незнакомый хост не проходит", () => {
    expect(isDisposableDatabase("postgresql://u:p@db.example.com:5432/prod")).toBe(false);
  });

  it("отсутствие строки — это «непонятно куда», а не «можно»", () => {
    expect(isDisposableDatabase(undefined)).toBe(false);
  });

  it("ответ не зависит от того, что лежит в окружении", () => {
    // На этом уже попался этот же файл: со значением параметра по умолчанию
    // явный undefined подставлял process.env.DATABASE_URL, и проверка «строки
    // нет» превращалась в проверку окружения. В CI переменная задана заглушкой
    // на 127.0.0.1 — тест падал ровно там, где локально проходил.
    vi.stubEnv("DATABASE_URL", "postgresql://build:build@127.0.0.1:5432/build");
    expect(isDisposableDatabase(undefined)).toBe(false);

    vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/bosdev");
    expect(isDisposableDatabase(NEON)).toBe(false);
    vi.unstubAllEnvs();
  });

  it("неразбираемая строка — тоже не «можно»", () => {
    // Молчаливое «ладно» здесь стоило бы всех операций владельца.
    expect(isDisposableDatabase("совсем не url")).toBe(false);
    expect(databaseHost("совсем не url")).toBeNull();
  });
});

describe("защита перед удалением", () => {
  it("на боевой падает", () => {
    expect(() => assertDisposableDatabase(NEON)).toThrow(/не выглядит расходной/);
  });

  it("на местной молчит", () => {
    expect(() => assertDisposableDatabase(LOCAL)).not.toThrow();
  });

  it("в сообщении об ошибке нет пароля и строки подключения", () => {
    // Сообщение попадёт в лог CI и в вывод терминала. Пароль там не нужен.
    try {
      assertDisposableDatabase(NEON);
      expect.unreachable("должно было упасть");
    } catch (e) {
      const text = (e as Error).message;
      expect(text).not.toContain("postgresql://");
      expect(text).not.toContain(":p@");
      expect(text).toContain("neon.tech"); // хост назвать надо — иначе непонятно, что не так
    }
  });
});

describe("защиту нельзя забыть подключить", () => {
  /**
   * Следующий живой тест напишут по образцу соседнего, и если образец окажется
   * без защиты — она вернётся к нулю. Поэтому связь «чистит таблицы → зовёт
   * assertDisposableDatabase» проверяется механически, а не на внимательность.
   */
  // fileURLToPath, а не .pathname: путь с пробелом или кириллицей приезжает
  // percent-кодированным, readdirSync падает с ENOENT, и выглядит это как что
  // угодно, только не как «живому тесту не хватает гейта».
  const SRC = fileURLToPath(new URL("../../", import.meta.url));

  function testFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...testFiles(path));
      else if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) out.push(path);
    }
    return out;
  }

  it("каждый живой тест проверяет базу заранее", () => {
    const unguarded = testFiles(SRC).filter((path) => {
      const source = readFileSync(path, "utf8");

      // Мок — не база. Файл, где @/core/db подменён, может звать что угодно:
      // ни одна строка от этого никуда не денется.
      const realDb = source.includes("@/core/db") && !/vi\.mock\(\s*["']@\/core\/db["']/.test(source);
      if (!realDb) return false;

      // Три признака живого теста, и каждый добавлен по своей причине.
      // deleteMany — исходный случай. Стирание в обход Prisma ($executeRaw,
      // TRUNCATE) правило по deleteMany не видело вовсе. А LIVE_DB ловит третий
      // род: тест, который ничего не стирает, но ПИШЕТ — такой не менее опасен,
      // его строки садятся в KPI и в месячные итоги неотличимо от настоящих.
      const wipes = /\.deleteMany\(/.test(source);
      const rawWipes = /\$executeRaw|TRUNCATE|DELETE\s+FROM|DROP\s+TABLE/i.test(source);
      const live = source.includes("LIVE_DB");

      return (wipes || rawWipes || live) && !source.includes("assertDisposableDatabase");
    });

    expect(
      unguarded.map((p) => p.slice(SRC.length)),
      "эти тесты работают с настоящей базой без проверки, что она расходная",
    ).toEqual([]);
  });
});
