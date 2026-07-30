import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  breakerKey,
  clearAllBreakers,
  filterHealthy,
  isBreakerOpen,
  resetBreaker,
  tripBreaker,
} from "./circuit-breaker";

let savedCooldown: string | undefined;

beforeEach(() => {
  savedCooldown = process.env.LLM_BREAKER_COOLDOWN_MS;
  clearAllBreakers();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-29T10:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  clearAllBreakers();
  if (savedCooldown === undefined) delete process.env.LLM_BREAKER_COOLDOWN_MS;
  else process.env.LLM_BREAKER_COOLDOWN_MS = savedCooldown;
});

describe("breakerKey", () => {
  it("различает одну модель на разных шлюзах", () => {
    expect(breakerKey("polza", "openai/gpt-4o-mini")).toBe("polza:openai/gpt-4o-mini");
    expect(breakerKey("proxyapi", "gpt-4o-mini")).not.toBe(breakerKey("polza", "gpt-4o-mini"));
  });
});

describe("открытие и кулдаун", () => {
  it("свежий вариант считается здоровым", () => {
    expect(isBreakerOpen("polza:m")).toBe(false);
  });

  it("провал открывает брейкер на кулдаун по умолчанию (45 с)", () => {
    delete process.env.LLM_BREAKER_COOLDOWN_MS;
    tripBreaker("polza:m");
    expect(isBreakerOpen("polza:m")).toBe(true);

    vi.advanceTimersByTime(44_999);
    expect(isBreakerOpen("polza:m")).toBe(true);

    vi.advanceTimersByTime(2);
    expect(isBreakerOpen("polza:m")).toBe(false);
  });

  it("кулдаун берётся из env на момент провала", () => {
    process.env.LLM_BREAKER_COOLDOWN_MS = "5000";
    tripBreaker("polza:m");

    vi.advanceTimersByTime(4_000);
    expect(isBreakerOpen("polza:m")).toBe(true);
    vi.advanceTimersByTime(1_001);
    expect(isBreakerOpen("polza:m")).toBe(false);
  });

  it("некорректный кулдаун откатывается к дефолту", () => {
    process.env.LLM_BREAKER_COOLDOWN_MS = "-1";
    tripBreaker("polza:m");
    vi.advanceTimersByTime(44_000);
    expect(isBreakerOpen("polza:m")).toBe(true);
  });

  it("успешный ответ закрывает брейкер досрочно", () => {
    tripBreaker("polza:m");
    resetBreaker("polza:m");
    expect(isBreakerOpen("polza:m")).toBe(false);
  });

  it("брейкеры независимы", () => {
    tripBreaker("polza:m");
    expect(isBreakerOpen("proxyapi:m")).toBe(false);
  });
});

describe("filterHealthy", () => {
  const variants = [{ key: "polza:m" }, { key: "proxyapi:m" }];
  const keyOf = (v: { key: string }) => v.key;

  it("сохраняет порядок каскада", () => {
    expect(filterHealthy(variants, keyOf).map(keyOf)).toEqual(["polza:m", "proxyapi:m"]);
  });

  it("выбрасывает больной вариант", () => {
    tripBreaker("polza:m");
    expect(filterHealthy(variants, keyOf).map(keyOf)).toEqual(["proxyapi:m"]);
  });

  it("fail-open: если открыты все, пробуем всё равно", () => {
    tripBreaker("polza:m");
    tripBreaker("proxyapi:m");
    expect(filterHealthy(variants, keyOf).map(keyOf)).toEqual(["polza:m", "proxyapi:m"]);
  });

  it("пустой вход остаётся пустым", () => {
    expect(filterHealthy([], keyOf)).toEqual([]);
  });
});
