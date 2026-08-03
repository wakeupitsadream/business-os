import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/core/db";
import { assertDisposableDatabase } from "@/core/testing/live-db";
import { ConnectorError } from "./types";
import { assertCanRequest, reserveRequest, resetMinuteWindow, usedToday, utcDayKey } from "./throttle";

/**
 * Троттлинг источников лидогена — на настоящей базе.
 *
 * Моками здесь проверять нечего: смысл суточного капа именно в том, что он
 * живёт в базе и переживает перезапуск контейнера. Проверка на подменённом
 * prisma доказывала бы, что вызвались нужные функции, а вопрос стоит другой —
 * останется ли счётчик на месте после деплоя.
 */

const live = process.env.LIVE_DB === "1";

const LIMITS = { requestsPerMinute: 100, dailyCap: 5 };
/** Отдельный лимит для проверок частоты — суточный тут не должен мешать. */
const FAST = { requestsPerMinute: 3, dailyCap: 10_000 };

const NOW = new Date("2026-08-02T10:00:00Z");

describe.runIf(live)("троттлинг коннекторов", () => {
  beforeEach(async () => {
    assertDisposableDatabase();
    await prisma.connectorQuota.deleteMany({});
    resetMinuteWindow();
  });

  it("суточный расход считается в базе и переживает перезапуск", async () => {
    // Главное свойство. Счётчик в памяти обнулялся бы на каждом деплое, и три
    // деплоя за день пробивали бы кап втрое — молча.
    for (let i = 0; i < 3; i += 1) {
      const d = await reserveRequest("stub", LIMITS, NOW);
      expect(d.allowed).toBe(true);
    }

    // Имитируем перезапуск контейнера: память чиста, база — нет.
    resetMinuteWindow();

    expect(await usedToday("stub", NOW)).toBe(3);
    const after = await reserveRequest("stub", LIMITS, NOW);
    expect(after.allowed).toBe(true);
    expect(after.dailyRemaining).toBe(1);
  });

  it("на потолке суточного капа отказывает", async () => {
    for (let i = 0; i < LIMITS.dailyCap; i += 1) {
      expect((await reserveRequest("stub", LIMITS, NOW)).allowed).toBe(true);
    }

    const blocked = await reserveRequest("stub", LIMITS, NOW);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("daily");
    // Срок — до полуночи UTC: именно тогда обнулится наш день.
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(24 * 3600);
  });

  it("расход не перетекает между сутками", async () => {
    for (let i = 0; i < LIMITS.dailyCap; i += 1) await reserveRequest("stub", LIMITS, NOW);
    expect((await reserveRequest("stub", LIMITS, NOW)).allowed).toBe(false);

    const tomorrow = new Date("2026-08-03T00:00:01Z");
    resetMinuteWindow();
    expect((await reserveRequest("stub", LIMITS, tomorrow)).allowed).toBe(true);
    expect(await usedToday("stub", tomorrow)).toBe(1);
    // Вчерашний счётчик не тронут — он и не должен.
    expect(await usedToday("stub", NOW)).toBe(LIMITS.dailyCap);
  });

  it("каждый источник тратит свою квоту", async () => {
    for (let i = 0; i < LIMITS.dailyCap; i += 1) await reserveRequest("stub", LIMITS, NOW);

    expect((await reserveRequest("stub", LIMITS, NOW)).allowed).toBe(false);
    // Исчерпанный Яндекс не должен закрывать 2ГИС и наоборот.
    expect((await reserveRequest("yandex_geo", LIMITS, NOW)).allowed).toBe(true);
  });

  it("параллельные запросы не пробивают кап", async () => {
    // Проверка ради того, что проверить больше нечем: между SELECT и UPDATE
    // помещается второй вызов, и оба занимают последнее место в капе.
    // Инкремент под условием этого не допускает.
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () => reserveRequest("stub", LIMITS, NOW)),
    );

    const allowed = attempts.filter((a) => a.allowed).length;
    expect(allowed).toBe(LIMITS.dailyCap);
    expect(await usedToday("stub", NOW)).toBe(LIMITS.dailyCap);
  });

  it("частота ограничивается в минутном окне", async () => {
    for (let i = 0; i < FAST.requestsPerMinute; i += 1) {
      expect((await reserveRequest("stub", FAST, NOW)).allowed).toBe(true);
    }

    const blocked = await reserveRequest("stub", FAST, NOW);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("minute");
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it("минутное окно проезжает", async () => {
    for (let i = 0; i < FAST.requestsPerMinute; i += 1) await reserveRequest("stub", FAST, NOW);
    expect((await reserveRequest("stub", FAST, NOW)).allowed).toBe(false);

    const later = new Date(NOW.getTime() + 61_000);
    expect((await reserveRequest("stub", FAST, later)).allowed).toBe(true);
  });

  it("отказ по частоте НЕ тратит суточную квоту", async () => {
    // Иначе упёршийся в частоту прогон сжигал бы дневной лимит, ничего не
    // получив, — и владелец остался бы и без данных, и без квоты.
    for (let i = 0; i < FAST.requestsPerMinute; i += 1) await reserveRequest("stub", FAST, NOW);
    const before = await usedToday("stub", NOW);

    const blocked = await reserveRequest("stub", FAST, NOW);
    expect(blocked.allowed).toBe(false);

    expect(await usedToday("stub", NOW)).toBe(before);
  });

  it("assertCanRequest бросает понятной ошибкой, а не молча пропускает", async () => {
    for (let i = 0; i < LIMITS.dailyCap; i += 1) await reserveRequest("stub", LIMITS, NOW);

    await expect(assertCanRequest("stub", LIMITS, NOW)).rejects.toThrow(ConnectorError);
    await expect(assertCanRequest("stub", LIMITS, NOW)).rejects.toThrow(/Суточный лимит/);
  });

  it("ключ дня — календарный UTC", async () => {
    // Не по поясу владельца: его сутки (UTC+5) начинаются раньше, и счётчик
    // обнулялся бы до того, как обнулится квота у провайдера.
    expect(utcDayKey(new Date("2026-08-02T23:59:59Z"))).toBe("2026-08-02");
    expect(utcDayKey(new Date("2026-08-03T00:00:00Z"))).toBe("2026-08-03");
  });
});
