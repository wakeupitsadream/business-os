import type { AgentDefinition } from "@/core/orchestrator";
import { ToolRegistry } from "@/core/orchestrator";
import { buildSecretaryPrompt } from "./prompt";
import { completeTask, createTask, listTasks } from "./tools/tasks";
import { cancelReminder, listReminders, setReminder } from "./tools/reminders";
import { recallMemory, saveMemoryFact } from "./tools/memory";
import {
  createGoal,
  getWellbeing,
  listGoals,
  logCheckIn,
  setLifeAreaScore,
} from "./tools/wellbeing";
import { addTransaction, listRecentTransactions, queryFinance } from "@/modules/finance";

/**
 * Секретарь: набор инструментов + промпт.
 *
 * Реестр собирается один раз на модуль, а не на каждый запуск: описания
 * инструментов неизменны, а вот системный промпт строится заново — в нём
 * текущее время владельца.
 *
 * Финансовые инструменты живут в своём модуле, но регистрируются здесь: учёт
 * должен работать из того же разговора, где владелец ставит задачи. Отдельный
 * «финансовый чат», в который надо специально зайти, не ведётся вовсе.
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
  logCheckIn,
  getWellbeing,
  setLifeAreaScore,
  createGoal,
  listGoals,
  addTransaction,
  queryFinance,
  listRecentTransactions,
]);

export const secretaryAgent: AgentDefinition = {
  key: "secretary",
  registry,
  buildSystemPrompt: (ctx) => buildSecretaryPrompt(ctx),
};

export { registry as secretaryRegistry };
