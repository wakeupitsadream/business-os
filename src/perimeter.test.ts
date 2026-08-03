import { describe, expect, it } from "vitest";
import { isPublicPath } from "./middleware";

/**
 * Периметр: что открыто без входа.
 *
 * Список публичного расширяется редко и каждый раз с обоснованием, поэтому он
 * закреплён тестом целиком: новая строка в нём должна быть осознанной, а не
 * приехать вместе с чужой правкой.
 */

describe("открыто без сессии", () => {
  it("вход и его роут", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/api/auth/login")).toBe(true);
  });

  it("проверка здоровья — её дёргает хостинг, у него сессии нет", () => {
    expect(isPublicPath("/api/health")).toBe(true);
    expect(isPublicPath("/api/health/live")).toBe(true);
  });

  it("вебхук и кроны — у них своя авторизация по секрету", () => {
    expect(isPublicPath("/api/telegram/webhook")).toBe(true);
    expect(isPublicPath("/api/cron/daily-brief")).toBe(true);
  });

  it("страница «нет связи» — её кэширует service worker до всякого входа", () => {
    // На ней нет ни одной цифры: в этом весь смысл страницы.
    expect(isPublicPath("/offline")).toBe(true);
  });
});

describe("закрыто", () => {
  it("все экраны отделов", () => {
    for (const path of ["/", "/finance", "/sales", "/secretary", "/settings"]) {
      expect(isPublicPath(path), path).toBe(false);
    }
  });

  it("все прикладные роуты", () => {
    for (const path of [
      "/api/chat",
      "/api/finance/transactions",
      "/api/sales/leads/abc",
      "/api/sales/content",
      "/api/approvals/x",
    ]) {
      expect(isPublicPath(path), path).toBe(false);
    }
  });

  it("похожий на публичный путь не проходит по префиксу", () => {
    // Проверка идёт по точному совпадению, а не по началу строки: иначе
    // «/loginhack» и «/api/healthz-secret» оказались бы открыты.
    expect(isPublicPath("/loginhack")).toBe(false);
    expect(isPublicPath("/offline-secret")).toBe(false);
    expect(isPublicPath("/api/telegram/webhook-debug")).toBe(false);
  });

  it("вложенное под публичным префиксом остаётся публичным осознанно", () => {
    // /api/cron/ и /api/health/ — именно префиксы: имена джоб добавляются
    // часто, и перечислять их по одному значит однажды забыть.
    expect(isPublicPath("/api/cron/publish-content")).toBe(true);
    expect(isPublicPath("/api/cron/retention-check")).toBe(true);
  });
});
