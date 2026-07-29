import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  llmConfigured,
  presetTimeoutMs,
  resolveGateways,
  resolveVariants,
} from "./gateways";

const MANAGED_ENV = [
  "LLM_GATEWAYS",
  "POLZA_API_KEY",
  "PROXYAPI_API_KEY",
  "POLZA_BASE_URL",
  "PROXYAPI_BASE_URL",
  "POLZA_MODEL_SMART",
  "PROXYAPI_MODEL_SMART",
  "LLM_MODEL_SMART",
  "LLM_MODEL_HEAVY",
  "LLM_MODEL_CHEAP",
  "LLM_MODEL_EMBED",
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const name of MANAGED_ENV) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of MANAGED_ENV) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("resolveGateways", () => {
  it("возвращает пустой список без ключей", () => {
    expect(resolveGateways()).toEqual([]);
    expect(llmConfigured()).toBe(false);
  });

  it("включает только шлюзы, у которых есть ключ", () => {
    process.env.LLM_GATEWAYS = "polza,proxyapi";
    process.env.PROXYAPI_API_KEY = "key-2";

    const gateways = resolveGateways();
    expect(gateways.map((g) => g.id)).toEqual(["proxyapi"]);
    expect(llmConfigured()).toBe(true);
  });

  it("уважает порядок из LLM_GATEWAYS", () => {
    process.env.LLM_GATEWAYS = "proxyapi,polza";
    process.env.POLZA_API_KEY = "key-1";
    process.env.PROXYAPI_API_KEY = "key-2";

    expect(resolveGateways().map((g) => g.id)).toEqual(["proxyapi", "polza"]);
  });

  it("игнорирует неизвестные и повторяющиеся id", () => {
    process.env.LLM_GATEWAYS = "polza, unknown ,polza";
    process.env.POLZA_API_KEY = "key-1";

    expect(resolveGateways().map((g) => g.id)).toEqual(["polza"]);
  });

  it("по умолчанию каскад polza → proxyapi", () => {
    process.env.POLZA_API_KEY = "key-1";
    process.env.PROXYAPI_API_KEY = "key-2";

    expect(resolveGateways().map((g) => g.id)).toEqual(["polza", "proxyapi"]);
  });

  it("переопределяет базовый URL и срезает хвостовой слеш", () => {
    process.env.POLZA_API_KEY = "key-1";
    process.env.POLZA_BASE_URL = "https://proxy.local/api/v1/";

    expect(resolveGateways()[0]?.baseUrl).toBe("https://proxy.local/api/v1");
  });

  it("у каждого шлюза своё пространство имён моделей", () => {
    process.env.POLZA_API_KEY = "key-1";
    process.env.PROXYAPI_API_KEY = "key-2";

    const [polza, proxyapi] = resolveGateways();
    expect(polza?.models.smart).toContain("/");
    expect(proxyapi?.models.smart).not.toContain("/");
    expect(polza?.models.embed).toBe("openai/text-embedding-3-small");
    expect(proxyapi?.models.embed).toBe("text-embedding-3-small");
  });
});

describe("переопределение моделей", () => {
  it("LLM_MODEL_* применяется к шлюзу того же стиля id", () => {
    process.env.POLZA_API_KEY = "key-1";
    process.env.PROXYAPI_API_KEY = "key-2";
    process.env.LLM_MODEL_SMART = "anthropic/claude-opus-4.1";

    const [polza, proxyapi] = resolveGateways();
    expect(polza?.models.smart).toBe("anthropic/claude-opus-4.1");
    // Плоский шлюз сохраняет свой дефолт — иначе резерв гарантированно 404.
    expect(proxyapi?.models.smart).toBe("gpt-4.1");
  });

  it("плоский LLM_MODEL_* применяется к плоскому шлюзу", () => {
    process.env.POLZA_API_KEY = "key-1";
    process.env.PROXYAPI_API_KEY = "key-2";
    process.env.LLM_MODEL_CHEAP = "gpt-4.1-nano";

    const [polza, proxyapi] = resolveGateways();
    expect(polza?.models.cheap).toBe("openai/gpt-4o-mini");
    expect(proxyapi?.models.cheap).toBe("gpt-4.1-nano");
  });

  it("переопределение на конкретный шлюз важнее глобального", () => {
    process.env.POLZA_API_KEY = "key-1";
    process.env.LLM_MODEL_SMART = "anthropic/claude-opus-4.1";
    process.env.POLZA_MODEL_SMART = "deepseek/deepseek-chat";

    expect(resolveGateways()[0]?.models.smart).toBe("deepseek/deepseek-chat");
  });

  it("пустая строка в env не считается переопределением", () => {
    process.env.POLZA_API_KEY = "key-1";
    process.env.LLM_MODEL_SMART = "   ";

    expect(resolveGateways()[0]?.models.smart).toBe("anthropic/claude-sonnet-4.5");
  });
});

describe("resolveVariants", () => {
  it("строит варианты каскада с ключами для брейкера", () => {
    process.env.POLZA_API_KEY = "key-1";
    process.env.PROXYAPI_API_KEY = "key-2";

    const variants = resolveVariants("cheap");
    expect(variants.map((v) => v.key)).toEqual([
      "polza:openai/gpt-4o-mini",
      "proxyapi:gpt-4o-mini",
    ]);
  });
});

describe("presetTimeoutMs", () => {
  it("дорогие роли ждут дольше дешёвых", () => {
    expect(presetTimeoutMs("heavy")).toBe(60_000);
    expect(presetTimeoutMs("smart")).toBe(60_000);
    expect(presetTimeoutMs("cheap")).toBe(30_000);
    expect(presetTimeoutMs("embed")).toBe(20_000);
  });
});
