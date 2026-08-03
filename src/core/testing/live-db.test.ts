import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
  const SRC = new URL("../../", import.meta.url).pathname;

  function testFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...testFiles(path));
      else if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) out.push(path);
    }
    return out;
  }

  it("каждый тест, стирающий таблицу целиком, проверяет базу заранее", () => {
    const unguarded = testFiles(SRC).filter((path) => {
      const source = readFileSync(path, "utf8");
      // deleteMany без аргументов или с пустым фильтром — это «снести всё».
      const wipes = /\.deleteMany\(\s*(\{\s*\}\s*)?\)/.test(source);
      return wipes && !source.includes("assertDisposableDatabase");
    });

    expect(
      unguarded.map((p) => p.slice(SRC.length)),
      "эти тесты стирают таблицы без проверки, что база расходная",
    ).toEqual([]);
  });
});
