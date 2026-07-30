import type { TxType } from "@prisma/client";
import { prisma } from "@/core/db";
import { matchCategoryByAliases, type CategoryOption } from "../categorize";
import { normalizeText } from "../text";

/**
 * Автокатегоризация импортированных строк.
 *
 * Порядок: MCC → подстрока из правил → алиасы. Всё кодом, без единого
 * обращения к модели: строк в выписке сотни, и вызов на каждую превратил бы
 * импорт в дорогую и медленную операцию. Ради этого случая в `resolveCategory`
 * и был предусмотрен `allowLlm: false` — здесь модель не зовётся вовсе.
 *
 * MCC идёт первым, потому что это код, присвоенный платёжной системой:
 * 5541 — заправка, и никакое описание этого не переспорит. Подстрока —
 * следующая по надёжности. Алиасы последние: они написаны под речь владельца
 * («потратил на бензин»), а не под названия мерчантов.
 */

export interface ImportRule {
  contains?: string;
  mcc?: number;
}

export interface CategoryRuleSet extends CategoryOption {
  rules: ImportRule[];
}

export interface RuleMatch {
  id: string;
  name: string;
  via: "mcc" | "contains" | "alias";
  matched: string;
}

/**
 * Разбор колонки `Category.rules`.
 *
 * Json-колонку может испортить кто угодно — правка руками в базе, старый
 * формат после деплоя. Мусор здесь не должен ронять импорт целиком: категория
 * без правил просто не участвует в подборе по правилам.
 */
export function parseCategoryRules(raw: unknown): ImportRule[] {
  if (!Array.isArray(raw)) return [];

  const rules: ImportRule[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;

    const rule: ImportRule = {};
    if (typeof record.contains === "string" && record.contains.trim().length > 0) {
      rule.contains = record.contains.trim();
    }
    if (typeof record.mcc === "number" && Number.isInteger(record.mcc)) {
      rule.mcc = record.mcc;
    }
    if (rule.contains !== undefined || rule.mcc !== undefined) rules.push(rule);
  }
  return rules;
}

export async function loadRuleSets(type: TxType): Promise<CategoryRuleSet[]> {
  const rows = await prisma.category.findMany({
    where: { type, isArchived: false },
    orderBy: { sortOrder: "asc" },
    select: { id: true, name: true, type: true, aliases: true, parentId: true, rules: true },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    aliases: row.aliases,
    parentId: row.parentId,
    rules: parseCategoryRules(row.rules),
  }));
}

export interface CategorizeInput {
  description: string;
  mcc?: number | null;
  /** Категория, проставленная банком: используется как дополнительный текст. */
  bankCategory?: string | null;
}

export function categorizeImportedRow(
  input: CategorizeInput,
  sets: CategoryRuleSet[],
): RuleMatch | null {
  const byMcc = matchByMcc(input.mcc ?? null, sets);
  if (byMcc) return byMcc;

  const haystack = normalizeText(`${input.description} ${input.bankCategory ?? ""}`);
  const byContains = matchByContains(haystack, sets);
  if (byContains) return byContains;

  // Последняя ступень — те же алиасы, что разбирают речь владельца.
  // Названия магазинов они ловят редко, но «реклама» в назначении платежа —
  // вполне.
  const byAlias = matchCategoryByAliases(
    `${input.description} ${input.bankCategory ?? ""}`,
    sets,
  );
  if (byAlias) return { id: byAlias.id, name: byAlias.name, via: "alias", matched: byAlias.matched ?? "" };

  // Ничего не подошло — категории нет. Не «Прочее»: пустая категория видна и
  // вызывает вопрос, «Прочее» выглядит как решение и собирает треть оборота.
  return null;
}

function matchByMcc(mcc: number | null, sets: CategoryRuleSet[]): RuleMatch | null {
  if (mcc === null) return null;

  for (const set of sets) {
    for (const rule of set.rules) {
      if (rule.mcc === mcc) {
        return { id: set.id, name: set.name, via: "mcc", matched: String(mcc) };
      }
    }
  }
  return null;
}

/**
 * Побеждает самая длинная подстрока: «яндекс директ» конкретнее «яндекс».
 * При равной длине выигрывает подкатегория — она точнее описывает расход.
 */
function matchByContains(haystack: string, sets: CategoryRuleSet[]): RuleMatch | null {
  let best: (RuleMatch & { weight: number; specific: boolean }) | null = null;

  for (const set of sets) {
    for (const rule of set.rules) {
      if (!rule.contains) continue;
      const needle = normalizeText(rule.contains);
      if (needle.length === 0 || !haystack.includes(needle)) continue;

      const weight = needle.length;
      const specific = set.parentId !== null;
      if (
        best === null ||
        weight > best.weight ||
        (weight === best.weight && specific && !best.specific)
      ) {
        best = { id: set.id, name: set.name, via: "contains", matched: needle, weight, specific };
      }
    }
  }

  if (!best) return null;
  return { id: best.id, name: best.name, via: best.via, matched: best.matched };
}
