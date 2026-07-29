import { beforeEach, describe, expect, it } from "vitest";
import {
  LOGIN_MAX_ATTEMPTS,
  LOGIN_WINDOW_MS,
  clientIp,
  hitLoginAttempt,
  rateLimitMessage,
  resetLoginAttempts,
  resetLoginRateLimitStore,
} from "./rate-limit";

const T0 = 1_800_000_000_000;

beforeEach(() => {
  resetLoginRateLimitStore();
});

describe("hitLoginAttempt", () => {
  it("пропускает ровно LOGIN_MAX_ATTEMPTS попыток, затем блокирует", () => {
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) {
      const result = hitLoginAttempt("1.1.1.1", T0 + i);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(LOGIN_MAX_ATTEMPTS - i - 1);
    }

    const blocked = hitLoginAttempt("1.1.1.1", T0 + LOGIN_MAX_ATTEMPTS);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(LOGIN_WINDOW_MS / 1000);
  });

  it("блокировка снимается после окна", () => {
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) hitLoginAttempt("2.2.2.2", T0);
    expect(hitLoginAttempt("2.2.2.2", T0 + 1).allowed).toBe(false);

    expect(hitLoginAttempt("2.2.2.2", T0 + LOGIN_WINDOW_MS + 1).allowed).toBe(true);
  });

  it("окно скользящее: старые попытки выбывают по одной", () => {
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) hitLoginAttempt("3.3.3.3", T0 + i * 1000);
    expect(hitLoginAttempt("3.3.3.3", T0 + 5000).allowed).toBe(false);

    // Первая попытка (T0) вышла из окна — освободился ровно один слот.
    const afterFirstExpired = T0 + LOGIN_WINDOW_MS + 1;
    expect(hitLoginAttempt("3.3.3.3", afterFirstExpired).allowed).toBe(true);
    expect(hitLoginAttempt("3.3.3.3", afterFirstExpired).allowed).toBe(false);
  });

  it("лимиты разных IP независимы", () => {
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) hitLoginAttempt("4.4.4.4", T0);
    expect(hitLoginAttempt("4.4.4.4", T0).allowed).toBe(false);
    expect(hitLoginAttempt("5.5.5.5", T0).allowed).toBe(true);
  });

  it("успешный вход обнуляет счётчик", () => {
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) hitLoginAttempt("6.6.6.6", T0);
    resetLoginAttempts("6.6.6.6");
    expect(hitLoginAttempt("6.6.6.6", T0).allowed).toBe(true);
  });

  it("не блокирует всех разом при перезаполнении карты (уборка не роняет счётчики)", () => {
    for (let i = 0; i < 50; i += 1) hitLoginAttempt(`10.0.0.${i}`, T0);
    // Спустя окно карта чистится, но активный IP продолжает считаться корректно.
    const later = T0 + LOGIN_WINDOW_MS + 1;
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) hitLoginAttempt("10.0.0.1", later + i);
    expect(hitLoginAttempt("10.0.0.1", later + 100).allowed).toBe(false);
  });
});

describe("clientIp", () => {
  it("берёт первый адрес из x-forwarded-for", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1, 10.0.0.2" });
    expect(clientIp(headers)).toBe("203.0.113.7");
  });

  it("падает на x-real-ip, затем на unknown", () => {
    expect(clientIp(new Headers({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

describe("rateLimitMessage", () => {
  it("склоняет минуты по-русски", () => {
    expect(rateLimitMessage(30)).toBe("Слишком много попыток, попробуйте через 1 минуту");
    expect(rateLimitMessage(3 * 60)).toBe("Слишком много попыток, попробуйте через 3 минуты");
    expect(rateLimitMessage(15 * 60)).toBe("Слишком много попыток, попробуйте через 15 минут");
    expect(rateLimitMessage(11 * 60)).toBe("Слишком много попыток, попробуйте через 11 минут");
  });
});
