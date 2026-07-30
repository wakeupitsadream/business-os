import type { AgentDefinition } from "@/core/orchestrator";
import { ToolRegistry } from "@/core/orchestrator";
import { buildSecretaryPrompt } from "./prompt";
import { completeTask, createTask, listTasks } from "./tools/tasks";
import { cancelReminder, listReminders, setReminder } from "./tools/reminders";
import { recallMemory, saveMemoryFact } from "./tools/memory";

/**
 * Секретарь: набор инструментов + промпт.
 *
 * Реестр собирается один раз на модуль, а не на каждый запуск: описания
 * инструментов неизменны, а вот системный промпт строится заново — в нём
 * текущее время владельца.
 */
const registry = new ToolRegistry().registerAll([
  createTask,
  listTasks,
  completeTask,
  setReminder,
  listReminders,
  cancelReminder,
  saveMemoryFact,
  recallMemory,
]);

export const secretaryAgent: AgentDefinition = {
  key: "secretary",
  registry,
  buildSystemPrompt: (ctx) => buildSecretaryPrompt(ctx),
};

export { registry as secretaryRegistry };
