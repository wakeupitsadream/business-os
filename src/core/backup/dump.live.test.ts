import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { BackupError, dumpDatabase } from "./dump";
import { assertDisposableDatabase, liveDbEnabled } from "@/core/testing/live-db";

/**
 * Дамп на настоящем PostgreSQL.
 *
 * Юниты не ответят на единственный важный вопрос: восстановим ли файл. Здесь
 * дамп снимается с живой локальной базы и проверяется по маркерам формата —
 * если это ломается, ночные «копии» превращаются в мусор при зелёных тестах.
 */

const hasPgDump = spawnSync("pg_dump", ["--version"]).status === 0;

/** DATABASE_URL в тестовом процессе не задан — его читает Prisma из .env. */
function localUrl(): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const m = readFileSync(".env", "utf8").match(/^DATABASE_URL="?([^"\n]+?)"?$/m);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

describe.runIf(liveDbEnabled && hasPgDump)("дамп живой базы", () => {
  it("снимается, сжимается и содержит то, из чего можно восстановиться", async () => {
    const url = localUrl();
    expect(url).toBeTruthy();
    // Дамп ничего не пишет, но наводить тесты на боевую базу нельзя даже
    // читателем: гейт единый для всех живых тестов.
    assertDisposableDatabase(url!);

    const dump = await dumpDatabase(url!);
    const text = gunzipSync(dump.gz).toString("utf8");

    expect(text).toContain("PostgreSQL database dump");
    expect(text).toContain('CREATE TABLE');
    expect(text).toContain('"Transaction"');
    expect(dump.gzBytes).toBeLessThan(dump.rawBytes);
  });
});

describe.runIf(hasPgDump)("отказ дампа", () => {
  it("в тексте ошибки нет пароля и строки подключения", async () => {
    const bad = "postgresql://user:sup3rsecret@127.0.0.1:59999/nope?connect_timeout=1";
    try {
      await dumpDatabase(bad);
      expect.unreachable("должно было упасть");
    } catch (e) {
      expect(e).toBeInstanceOf(BackupError);
      expect((e as Error).message).not.toContain("sup3rsecret");
      expect((e as Error).message).not.toContain("postgresql://");
    }
  });
});
