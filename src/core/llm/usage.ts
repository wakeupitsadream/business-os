import { prisma } from "@/core/db";
import { envInt } from "@/core/env";
import { logError, logWarn } from "@/core/observability/logger";
import { dayBounds } from "@/core/shared/time";
import { LlmUnavailableError, type LlmPreset } from "./gateways";
import { estimateCostKop } from "./pricing";

/**
 * Учёт расходов на LLM и дневной потолок.
 *
 * Строка пишется на КАЖДЫЙ вызов, включая эмбеддинги и провалы: без провалов
 * в таблице деградация шлюза выглядит как «стало тихо», а не как инцидент.
 * Запись учёта никогда не должна ронять сам вызов — бухгалтерия не важнее
 * ответа владельцу.
 */

export interface UsageEntry {
  feature: string;
  preset: LlmPreset;
  gateway: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs?: number;
  ok: boolean;
  error?: string;
  runId?: string;
}

/** Длинные тексты ошибок раздувают строку и не читаются в дашборде. */
const MAX_ERROR_LEN = 500;

export async function recordUsage(entry: UsageEntry): Promise<number> {
  const costKop = estimateCostKop(entry.model, entry.inputTokens, entry.outputTokens);
  noteSpend(costKop);
  try {
    await prisma.llmUsage.create({
      data: {
        feature: entry.feature,
        preset: entry.preset,
        gateway: entry.gateway,
        model: entry.model,
        inputTokens: Math.max(0, Math.round(entry.inputTokens)),
        outputTokens: Math.max(0, Math.round(entry.outputTokens)),
        costKop,
        latencyMs: entry.latencyMs ?? null,
        ok: entry.ok,
        error: entry.error ? entry.error.slice(0, MAX_ERROR_LEN) : null,
        runId: entry.runId ?? null,
      },
    });
  } catch (e) {
    logError("llm.usage_write_failed", {
      feature: entry.feature,
      gateway: entry.gateway,
      model: entry.model,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return costKop;
}

/** Кэш суммы за сутки: считать агрегат на каждый вызов — лишний round-trip к Neon. */
const BUDGET_CACHE_TTL_MS = 60_000;
let budgetCache: { spentKop: number; at: number } | null = null;

/**
 * Учесть свежий расход в кэше. Без этого серия вызовов внутри одного
 * 60-секундного окна (агентный цикл — до 8 итераций) видит устаревший ноль и
 * пробивает лимит насквозь.
 */
function noteSpend(costKop: number): void {
  if (budgetCache) budgetCache.spentKop += costKop;
}

async function spentTodayKop(): Promise<number> {
  const now = Date.now();
  if (budgetCache && now - budgetCache.at < BUDGET_CACHE_TTL_MS) return budgetCache.spentKop;

  const { start, end } = dayBounds(new Date());
  const agg = await prisma.llmUsage.aggregate({
    _sum: { costKop: true },
    where: { createdAt: { gte: start, lt: end } },
  });
  const spentKop = agg._sum.costKop ?? 0;
  budgetCache = { spentKop, at: now };
  return spentKop;
}

/**
 * Проверка дневного бюджета (московские сутки, `LLM_DAILY_BUDGET_RUB`, 0 = без
 * лимита).
 *
 * Асимметрия намеренная: дорогие роли (smart/heavy) при исчерпании лимита
 * отказывают, дешёвые (cheap/embed) — проходят с предупреждением. Заблокировав
 * cheap, мы сломали бы фоновую рутину — классификацию, скоринг, индексацию
 * памяти — ради экономии копеек, при том что перерасход создают не они.
 */
export async function assertWithinDailyBudget(preset: LlmPreset, feature: string): Promise<void> {
  const budgetRub = envInt("LLM_DAILY_BUDGET_RUB", 0);
  if (budgetRub <= 0) return;
  const limitKop = budgetRub * 100;

  let spentKop: number;
  try {
    spentKop = await spentTodayKop();
  } catch (e) {
    // БД недоступна — это повод чинить БД, а не молча отключать ИИ.
    logError("llm.budget_check_failed", { error: e instanceof Error ? e.message : String(e) });
    return;
  }

  if (spentKop < limitKop) return;

  if (preset === "cheap" || preset === "embed") {
    logWarn("llm.budget_exceeded_allowed", { feature, preset, spentKop, limitKop });
    return;
  }

  logWarn("llm.budget_exceeded_blocked", { feature, preset, spentKop, limitKop });
  throw new LlmUnavailableError(
    `Дневной лимит расходов на ИИ исчерпан: потрачено ${Math.round(spentKop / 100)} ₽ из ${budgetRub} ₽. ` +
      "Лимит обнулится в полночь по Москве. Поднять его можно переменной LLM_DAILY_BUDGET_RUB.",
  );
}

/** Для тестов и для ручного сброса после правки лимита. */
export function resetBudgetCache(): void {
  budgetCache = null;
}
