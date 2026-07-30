import type { TxType } from "@prisma/client";
import { prisma } from "@/core/db";
import { llmChat } from "@/core/llm";
import { logWarn } from "@/core/observability/logger";
import { normalizeText, phraseOccurs, stemAll } from "./text";

/**
 * Подбор категории по описанию расхода.
 *
 * Два уровня, и порядок принципиален. Сначала алиасы — код, ноль задержки,
 * ноль денег, воспроизводимый результат. Только если код не нашёл ничего,
 * подключается дешёвая модель, и её ответ обязан оказаться в списке
 * существующих категорий: модель охотно придумывает «Прочие расходы»,
 * которых в справочнике нет.
 *
 * Категорию без совпадения оставляем ПУСТОЙ, а не сваливаем в «Прочее».
 * Пустая категория видна на экране и вызывает вопрос; «Прочее» выглядит как
 * осмысленное решение и через полгода собирает треть оборота.
 */

export interface CategoryOption {
  id: string;
  name: string;
  type: TxType;
  aliases: string[];
  /** Подкатегории конкретнее родителя и при равенстве выигрывают. */
  parentId: string | null;
}

export type CategoryMatch = {
  id: string;
  name: string;
  /** Чем сработало: алиасом, названием или выбором модели. */
  via: "alias" | "name" | "llm";
  matched?: string;
};

/**
 * Подбор кодом. Побеждает самое ДЛИННОЕ совпадение: «яндекс директ»
 * конкретнее «директ», а «спортзал» конкретнее «зал». При равной длине
 * побеждает подкатегория — она точнее описывает расход.
 */
export function matchCategoryByAliases(
  description: string,
  options: CategoryOption[],
): CategoryMatch | null {
  const textStems = stemAll(description);
  if (textStems.length === 0) return null;

  let best: (CategoryMatch & { weight: number; specific: boolean }) | null = null;

  for (const option of options) {
    const candidates: Array<{ phrase: string; via: "alias" | "name" }> = [
      { phrase: option.name, via: "name" },
      ...option.aliases.map((a) => ({ phrase: a, via: "alias" as const })),
    ];

    for (const candidate of candidates) {
      const phrase = normalizeText(candidate.phrase);
      if (phrase.length === 0 || !phraseOccurs(phrase, textStems)) continue;

      const weight = phrase.length;
      const specific = option.parentId !== null;
      if (
        best === null ||
        weight > best.weight ||
        (weight === best.weight && specific && !best.specific)
      ) {
        best = { id: option.id, name: option.name, via: candidate.via, matched: phrase, weight, specific };
      }
    }
  }

  if (!best) return null;
  return { id: best.id, name: best.name, via: best.via, matched: best.matched };
}

/** Категории нужного направления — то, из чего выбирают оба уровня подбора. */
export async function loadCategoryOptions(type: TxType): Promise<CategoryOption[]> {
  return prisma.category.findMany({
    where: { type, isArchived: false },
    orderBy: { sortOrder: "asc" },
    select: { id: true, name: true, type: true, aliases: true, parentId: true },
  });
}

/**
 * Полный подбор: алиасы, затем — при неудаче — дешёвая модель.
 *
 * `allowLlm: false` нужен пакетным сценариям (импорт выписки): там строк сотни,
 * и вызов модели на каждую превратил бы импорт в дорогую и медленную операцию.
 */
export async function resolveCategory(
  description: string,
  type: TxType,
  opts?: { allowLlm?: boolean; options?: CategoryOption[] },
): Promise<CategoryMatch | null> {
  const options = opts?.options ?? (await loadCategoryOptions(type));
  if (options.length === 0) return null;

  const byAlias = matchCategoryByAliases(description, options);
  if (byAlias) return byAlias;

  if (opts?.allowLlm === false) return null;
  return askModelForCategory(description, options);
}

async function askModelForCategory(
  description: string,
  options: CategoryOption[],
): Promise<CategoryMatch | null> {
  const names = options.map((o) => o.name);

  try {
    const result = await llmChat({
      feature: "finance.categorize",
      preset: "cheap",
      maxTokens: 30,
      messages: [
        {
          role: "system",
          content: [
            "Выбери категорию для операции из списка. Ответь ОДНИМ названием",
            "точно как в списке, без пояснений и кавычек. Если ни одна не",
            'подходит — ответь ровно "нет".',
            "",
            "Список:",
            ...names.map((n) => `- ${n}`),
          ].join("\n"),
        },
        { role: "user", content: description },
      ],
    });

    const answer = normalizeText(result.text);
    if (answer.length === 0 || answer === "нет") return null;

    // Сверка с реальным справочником: без неё в базу уезжает выдуманное
    // моделью название, а операция остаётся вообще без категории.
    const hit = options.find((o) => normalizeText(o.name) === answer);
    if (!hit) return null;

    return { id: hit.id, name: hit.name, via: "llm" };
  } catch (e) {
    // Не подобрать категорию — не повод потерять операцию: сумма и дата важнее.
    logWarn("finance.categorize_llm_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
