import { optionalEnv } from "@/core/env";

/**
 * Конфигурация каскада LLM-шлюзов.
 *
 * Все шлюзы — OpenAI-совместимые агрегаторы с рублёвой оплатой, поэтому форма
 * запроса одна на всех, различаются только базовый URL, ключ и id моделей.
 * Порядок каскада задаётся env `LLM_GATEWAYS=polza,proxyapi`; шлюз попадает в
 * каскад только если у него есть ключ — иначе каждый запрос тратил бы попытку
 * на заведомо мёртвый вариант.
 *
 * Ключевое решение: код просит РОЛЬ («умная модель для диалога»), а не
 * конкретную модель. Смена модели или провайдера — это правка env, а не
 * тридцати call-site.
 */

export type LlmPreset = "smart" | "heavy" | "cheap" | "embed";

export const LLM_PRESETS: readonly LlmPreset[] = ["smart", "heavy", "cheap", "embed"];

export interface GatewayConfig {
  id: string;
  /** База до `/v1` включительно; `/chat/completions` дописывается вызовом. */
  baseUrl: string;
  apiKey: string;
  models: Record<LlmPreset, string>;
}

/** Конкретная попытка каскада: пара «шлюз + модель» с ключом для брейкера. */
export interface LlmVariant {
  gateway: GatewayConfig;
  model: string;
  key: string;
}

/**
 * Ошибка «ответить нечем»: не настроен ни один шлюз, весь каскад провалился
 * или упёрлись в дневной бюджет. Сообщение попадает пользователю как есть,
 * поэтому оно на русском и без технических подробностей.
 */
export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

interface GatewayPreset {
  baseUrl: string;
  keyEnv: string;
  models: Record<LlmPreset, string>;
}

/**
 * Модели заданы на КАЖДЫЙ шлюз отдельно, потому что пространства имён разные:
 * Polza использует namespace `provider/model`, ProxyAPI — плоские
 * OpenAI-совместимые id. Один общий id сломал бы второй шлюз в каскаде.
 *
 * У ProxyAPI роли smart/heavy отданы моделям OpenAI сознательно: Anthropic там
 * живёт на отдельном НЕ OpenAI-совместимом пути, и «честный» Claude в резерве
 * означал бы 404 ровно в тот момент, когда основной шлюз лежит.
 */
const GATEWAY_PRESETS: Record<string, GatewayPreset> = {
  polza: {
    baseUrl: "https://polza.ai/api/v1",
    keyEnv: "POLZA_API_KEY",
    models: {
      smart: "anthropic/claude-sonnet-4.5",
      heavy: "anthropic/claude-opus-4.1",
      cheap: "openai/gpt-4o-mini",
      embed: "openai/text-embedding-3-small",
    },
  },
  proxyapi: {
    baseUrl: "https://api.proxyapi.ru/openai/v1",
    keyEnv: "PROXYAPI_API_KEY",
    models: {
      smart: "gpt-4.1",
      heavy: "gpt-4.1",
      cheap: "gpt-4o-mini",
      embed: "text-embedding-3-small",
    },
  },
};

const PRESET_ENV: Record<LlmPreset, string> = {
  smart: "LLM_MODEL_SMART",
  heavy: "LLM_MODEL_HEAVY",
  cheap: "LLM_MODEL_CHEAP",
  embed: "LLM_MODEL_EMBED",
};

/** Id вида `provider/model` (стиль Polza) против плоского (стиль ProxyAPI). */
function isNamespaced(modelId: string): boolean {
  return modelId.includes("/");
}

/**
 * Итоговые модели шлюза с учётом переопределений.
 *
 * Приоритет: `<GATEWAY>_MODEL_<PRESET>` → `LLM_MODEL_<PRESET>` → дефолт шлюза.
 * Глобальный override применяется только к шлюзам того же стиля id: иначе
 * `LLM_MODEL_SMART=anthropic/claude-sonnet-4.5` подставился бы и в ProxyAPI,
 * превратив резервный шлюз в гарантированный 404 — то есть выключив резерв
 * ровно тогда, когда он нужен.
 */
function resolveModels(gatewayId: string, defaults: Record<LlmPreset, string>): Record<LlmPreset, string> {
  const result: Record<LlmPreset, string> = { ...defaults };
  for (const preset of LLM_PRESETS) {
    const perGateway = optionalEnv(`${gatewayId.toUpperCase()}_MODEL_${preset.toUpperCase()}`);
    if (perGateway) {
      result[preset] = perGateway;
      continue;
    }
    const global = optionalEnv(PRESET_ENV[preset]);
    if (global && isNamespaced(global) === isNamespaced(defaults[preset])) {
      result[preset] = global;
    }
  }
  return result;
}

/** Упорядоченный список шлюзов с ключами. Пустой список = LLM не настроен. */
export function resolveGateways(): GatewayConfig[] {
  const order = (optionalEnv("LLM_GATEWAYS") ?? "polza,proxyapi")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const gateways: GatewayConfig[] = [];
  const seen = new Set<string>();

  for (const id of order) {
    if (seen.has(id)) continue;
    const preset = GATEWAY_PRESETS[id];
    if (!preset) continue;
    const apiKey = optionalEnv(`${id.toUpperCase()}_API_KEY`) ?? optionalEnv(preset.keyEnv);
    if (!apiKey) continue;

    seen.add(id);
    gateways.push({
      id,
      baseUrl: (optionalEnv(`${id.toUpperCase()}_BASE_URL`) ?? preset.baseUrl).replace(/\/+$/, ""),
      apiKey,
      models: resolveModels(id, preset.models),
    });
  }

  return gateways;
}

export function llmConfigured(): boolean {
  return resolveGateways().length > 0;
}

/** Варианты каскада для роли, в порядке приоритета. */
export function resolveVariants(preset: LlmPreset): LlmVariant[] {
  return resolveGateways().map((gateway) => {
    const model = gateway.models[preset];
    return { gateway, model, key: `${gateway.id}:${model}` };
  });
}

/**
 * Таймаут одной попытки. Разный по ролям: за heavy-разбором владелец готов
 * подождать, а классификация внутри агентного цикла обязана вернуться быстро —
 * иначе один медленный вызов растягивает весь цикл.
 */
export function presetTimeoutMs(preset: LlmPreset): number {
  switch (preset) {
    case "embed":
      return 20_000;
    case "cheap":
      return 30_000;
    default:
      return 60_000;
  }
}

export const NOT_CONFIGURED_MESSAGE =
  "ИИ-шлюзы не настроены: нет ни одного ключа (POLZA_API_KEY или PROXYAPI_API_KEY).";
