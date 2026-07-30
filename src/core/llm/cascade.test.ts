import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cascadeBudgetMs, llmChat } from "./chat";
import { clearAllBreakers, isBreakerOpen } from "./circuit-breaker";
import { LlmUnavailableError, resolveVariants } from "./gateways";

/**
 * Тесты ОРКЕСТРАЦИИ каскада, а не отдельных его кусочков.
 *
 * Раньше здесь была дыра: проверялись только чистые хелперы (сборка тела
 * запроса, разбор ответа), а решения «идти ли к следующему шлюзу», «повторять
 * ли попытку», «помечать ли шлюз больным» не проверялись ничем. Из-за этого
 * жил дефект, при котором зависший первичный шлюз съедал весь бюджет времени,
 * резерв не опрашивался ни разу и вдобавок получал ложную отметку «больной» —
 * то есть механизм отказоустойчивости работал против себя, и все 153 теста при
 * этом были зелёными.
 */

const MANAGED_ENV = ["LLM_GATEWAYS", "POLZA_API_KEY", "PROXYAPI_API_KEY", "LLM_DAILY_BUDGET_RUB"];
let saved: Record<string, string | undefined> = {};

/** Ошибка ровно той формы, какую даёт AbortSignal.timeout при зависшем шлюзе. */
function timeoutError(): Error {
  const e = new Error("The operation was aborted due to timeout");
  e.name = "TimeoutError";
  return e;
}

function okResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: text } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function errorResponse(status: number): Response {
  return new Response(JSON.stringify({ error: { message: "нет" } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Какому шлюзу адресован запрос — по хосту, а не по порядку вызовов. */
function gatewayOf(input: RequestInfo | URL): "polza" | "proxyapi" | "unknown" {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("polza")) return "polza";
  if (url.includes("proxyapi")) return "proxyapi";
  return "unknown";
}

beforeEach(() => {
  saved = {};
  for (const name of MANAGED_ENV) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.LLM_GATEWAYS = "polza,proxyapi";
  process.env.POLZA_API_KEY = "key-polza";
  process.env.PROXYAPI_API_KEY = "key-proxyapi";
  clearAllBreakers();
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.unstubAllGlobals();
  clearAllBreakers();
});

const ASK = { feature: "test.cascade", messages: [{ role: "user" as const, content: "привет" }] };

describe("каскад: переход к резервному шлюзу", () => {
  it("зависший первичный шлюз не мешает резервному ответить", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const gw = gatewayOf(input);
      calls.push(gw);
      if (gw === "polza") throw timeoutError();
      return okResponse("ответ резерва");
    });

    const result = await llmChat({ ...ASK, preset: "smart" });

    expect(result.text).toBe("ответ резерва");
    expect(result.gateway).toBe("proxyapi");
    expect(calls).toContain("proxyapi");
  });

  it("таймаут не повторяется на том же шлюзе — повтор съел бы время резерва", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const gw = gatewayOf(input);
      calls.push(gw);
      if (gw === "polza") throw timeoutError();
      return okResponse("ок");
    });

    await llmChat({ ...ASK, preset: "smart" });

    expect(calls.filter((c) => c === "polza")).toHaveLength(1);
  });

  it("обрыв соединения (в отличие от таймаута) повторяется на том же шлюзе", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const gw = gatewayOf(input);
      calls.push(gw);
      if (gw === "polza") throw new TypeError("fetch failed");
      return okResponse("ок");
    });

    await llmChat({ ...ASK, preset: "cheap" });

    expect(calls.filter((c) => c === "polza")).toHaveLength(2);
  });

  it("когда молчат все шлюзы — понятная ошибка, а не зависание", async () => {
    vi.stubGlobal("fetch", async () => {
      throw timeoutError();
    });

    await expect(llmChat({ ...ASK, preset: "smart" })).rejects.toBeInstanceOf(LlmUnavailableError);
  });
});

describe("каскад: когда открывать брейкер", () => {
  /**
   * Ключ брейкера первичного шлюза для пресета. Берём его из той же функции,
   * которой пользуется рабочий код: угадывать имя модели в тесте — верный
   * способ получить проверку, которая всегда «проходит», ничего не проверяя.
   */
  function polzaKey(preset: "smart" | "cheap"): string {
    const variant = resolveVariants(preset).find((v) => v.gateway.id === "polza");
    if (!variant) throw new Error("шлюз polza не собрался — проверь окружение теста");
    return variant.key;
  }

  it("таймаут шлюза помечает его больным", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (gatewayOf(input) === "polza") throw timeoutError();
      return okResponse("ок");
    });

    const result = await llmChat({ ...ASK, preset: "smart" });

    expect(result.gateway).toBe("proxyapi");
    expect(isBreakerOpen(polzaKey("smart"))).toBe(true);
  });

  it("ошибка нашего запроса (400) НЕ помечает исправный шлюз больным", async () => {
    // Иначе один кривой вызов выключал бы рабочий шлюз на 45 секунд для всех
    // остальных функций системы разом.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (gatewayOf(input) === "polza") return errorResponse(400);
      return okResponse("ок");
    });

    const result = await llmChat({ ...ASK, preset: "cheap" });

    expect(result.gateway).toBe("proxyapi");
    expect(isBreakerOpen(polzaKey("cheap"))).toBe(false);
  });

  it("серверная ошибка шлюза (503) помечает его больным", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (gatewayOf(input) === "polza") return errorResponse(503);
      return okResponse("ок");
    });

    await llmChat({ ...ASK, preset: "cheap" });

    expect(isBreakerOpen(polzaKey("cheap"))).toBe(true);
  });
});

describe("cascadeBudgetMs", () => {
  it("растёт с числом вариантов — иначе первый вариант съедает весь бюджет", () => {
    expect(cascadeBudgetMs(60_000, 2)).toBeGreaterThan(cascadeBudgetMs(60_000, 1));
  });

  it("бюджет всегда больше, чем нужно одному варианту на все его попытки", () => {
    // Вариант делает до 2 попыток по attemptTimeout каждая. Если бюджет равен
    // этому произведению, второму варианту структурно достаётся ноль.
    const attempt = 60_000;
    const oneVariantWorstCase = attempt * 2;
    expect(cascadeBudgetMs(attempt, 2)).toBeGreaterThan(oneVariantWorstCase);
  });

  it("не вырождается при нулевом числе вариантов", () => {
    expect(cascadeBudgetMs(30_000, 0)).toBeGreaterThan(0);
  });
});
