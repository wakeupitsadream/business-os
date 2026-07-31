import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LiveDatabaseRefused, assertDisposableDatabase, inspectLiveDatabase } from "./live-db";

/**
 * Гейт одноразовой базы + защита от его обхода.
 *
 * Второй блок важнее первого: сам гейт бесполезен, если следующий живой тест
 * напишут без него. Поэтому исходники тестов читаются с диска — правило
 * «стираешь таблицы → зовёшь гейт» проверяется, а не подразумевается.
 */

const SRC = new URL("../../", import.meta.url).pathname;

describe("гейт одноразовой базы", () => {
  it("петлевой хост разрешён", () => {
    const env = { DATABASE_URL: "postgresql://u:p@localhost:5432/bos" };
    expect(inspectLiveDatabase(env)).toEqual({ ok: true, how: "loopback" });
  });

  it("127.0.0.1 и ::1 — тоже петля", () => {
    for (const host of ["127.0.0.1", "[::1]"]) {
      const env = { DATABASE_URL: `postgresql://u:p@${host}:5432/bos` };
      expect(inspectLiveDatabase(env).ok).toBe(true);
    }
  });

  it("боевой Neon отвергается", () => {
    // Ровно тот случай, ради которого гейт и заведён: LIVE_DB=1 при .env,
    // оставшемся от отладки прода.
    const env = {
      DATABASE_URL:
        "postgresql://owner:secret@ep-quiet-firefly-123456-pooler.eu-central-1.aws.neon.tech:5432/bos?sslmode=require",
    };

    const verdict = inspectLiveDatabase(env);
    expect(verdict.ok).toBe(false);
    expect(() => assertDisposableDatabase(env)).toThrow(LiveDatabaseRefused);
  });

  it("в причине отказа нет пароля", () => {
    // Причина попадает в вывод CI, а строка подключения содержит пароль.
    const env = {
      DATABASE_URL: "postgresql://owner:sup3rs3cret@db.example.com:5432/bos",
    };

    const verdict = inspectLiveDatabase(env);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).not.toContain("sup3rs3cret");
    expect(verdict.reason).toContain("db.example.com");
  });

  it("удалённая база разрешается явным TEST_DATABASE_URL", () => {
    const url = "postgresql://u:p@ep-sandbox.neon.tech:5432/bos_test";
    const env = { DATABASE_URL: url, TEST_DATABASE_URL: url };
    expect(inspectLiveDatabase(env)).toEqual({ ok: true, how: "test-url" });
  });

  it("TEST_DATABASE_URL от другой базы не разрешает боевую", () => {
    const env = {
      DATABASE_URL: "postgresql://u:p@prod.neon.tech:5432/bos",
      TEST_DATABASE_URL: "postgresql://u:p@localhost:5432/bos_test",
    };
    expect(inspectLiveDatabase(env).ok).toBe(false);
  });

  it("отсутствующий и битый DATABASE_URL — отказ, а не пропуск", () => {
    expect(inspectLiveDatabase({}).ok).toBe(false);
    expect(inspectLiveDatabase({ DATABASE_URL: "не-url" }).ok).toBe(false);
  });
});

describe("обход гейта", () => {
  it("каждый тест, ходящий в живую базу, зовёт гейт", () => {
    // Правило намеренно грубое: упоминание `LIVE_DB` или любой `deleteMany`
    // обязывает файл позвать гейт. Ложное срабатывание стоит одной строки
    // импорта, пропуск — таблицы операций.
    //
    // Про `LIVE_DB`, а не только про `deleteMany`: живой тест опасен и когда
    // ничего не стирает. `finance/live-check.test.ts` пишет операции с
    // источником SECRETARY — на боевой базе они неотличимы от настоящих и
    // молча садятся в KPI владельца.
    const offenders = testFiles(SRC)
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        const touchesLiveDb = source.includes(".deleteMany(") || source.includes("LIVE_DB");
        return touchesLiveDb && !source.includes("assertDisposableDatabase");
      })
      .map((file) => file.slice(SRC.length));

    expect(offenders).toEqual([]);
  });
});

function testFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...testFiles(path));
    else if (/\.test\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}
