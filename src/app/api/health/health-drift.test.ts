import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * HEALTHCHECK контейнера не должен ходить в базу.
 *
 * Проба идёт каждые 30 секунд — 2880 раз в сутки. Если она наведена на
 * `/api/health`, тот делает `SELECT 1`, компьют Neon не простаивает пять минут
 * никогда и не засыпает вовсе: месячный лимит бесплатного тарифа (100 CU-часов,
 * общих на весь аккаунт) выбирается недели за две с половиной, и вместе с этим
 * приложением встаёт всё остальное на том же Neon.
 *
 * Дефект бесшумный: и `/api/health`, и `/api/health/live` отвечают 200, всё
 * работает, счётчик тикает молча. Компилятор и обычные тесты этого не увидят,
 * поэтому связь «проба ↔ роут без базы» проверяется здесь явно.
 */

const DOCKERFILE = new URL("../../../../Dockerfile", import.meta.url);
const LIVE_ROUTE = new URL("./live/route.ts", import.meta.url);
const LIVE_PATH = "/api/health/live";

function healthcheckUrl(): string {
  const source = readFileSync(DOCKERFILE, "utf8");
  const line = source
    .split("\n")
    .find((l) => l.trimStart().startsWith("CMD curl") || l.includes("HEALTHCHECK"));
  const match = /https?:\/\/[^\s"']+/.exec(source.slice(source.indexOf("HEALTHCHECK")));
  return match?.[0] ?? `не нашли адрес пробы (строка: ${line ?? "—"})`;
}

describe("проба живости контейнера", () => {
  it("наведена на роут без базы", () => {
    expect(healthcheckUrl()).toContain(LIVE_PATH);
  });

  it("роут пробы не тянет за собой Prisma", () => {
    // Импорт `@/core/db` тут — это не «лишняя зависимость», а возвращение
    // ровно того дефекта, ради которого роут и отделяли.
    const source = readFileSync(LIVE_ROUTE, "utf8");
    expect(source).not.toContain("@/core/db");
    expect(source).not.toContain("prisma");
  });

  it("проба по-прежнему без флага -f", () => {
    // С -f curl падает на любом 5xx (лежащая база, режим техработ), хостинг
    // считает исправный контейнер битым и откатывается на старый образ.
    const source = readFileSync(DOCKERFILE, "utf8");
    const cmd = source.slice(source.indexOf("HEALTHCHECK"));
    expect(cmd).not.toMatch(/curl\s+(-\w*f|--fail)/);
  });
});
