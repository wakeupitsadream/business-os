/**
 * Публичный API LLM-подсистемы. Остальные модули импортируют только отсюда:
 * внутреннее устройство каскада (шлюзы, брейкеры, тарифы) не их дело.
 */

export {
  LlmUnavailableError,
  llmConfigured,
  resolveGateways,
  resolveVariants,
  presetTimeoutMs,
  type LlmPreset,
  type GatewayConfig,
  type LlmVariant,
} from "./gateways";

export {
  llmChat,
  ExternalAbortError,
  type LlmMessage,
  type LlmToolDef,
  type LlmToolCall,
  type LlmChatResult,
  type LlmChatOptions,
} from "./chat";

export { llmEmbed, EMBEDDING_DIMENSIONS } from "./embed";

export { recordUsage, assertWithinDailyBudget, resetBudgetCache, type UsageEntry } from "./usage";

export { estimateCostKop, modelPriceRub } from "./pricing";

export { clearAllBreakers, breakerKey, isBreakerOpen } from "./circuit-breaker";
