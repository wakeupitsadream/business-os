/**
 * Агентное ядро: цикл tool-calling, общий для всех отделов.
 * Модули регистрируют свои инструменты и получают готовый запуск.
 */

export { runAgent, type AgentDefinition } from "./agent-loop";
export { ToolRegistry, maskArgs, parseToolArgs, toJsonSchema } from "./tool-registry";
export type {
  AgentRunOptions,
  AgentRunResult,
  AgentTool,
  ToolContext,
  ToolResult,
} from "./types";
