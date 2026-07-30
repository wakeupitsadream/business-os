import { llmChat } from "@/core/llm";
import { logWarn } from "@/core/observability/logger";
import type { Fact } from "./facts";

/**
 * Формулировка карточек моделью.
 *
 * Модель получает готовые факты и не считает ничего. Её работа — связать два
 * числа в мысль, которую владелец прочитает за пять секунд: «реклама выросла
 * втрое, а выручка — на четверть».
 *
 * Обязательное условие: карточка ссылается на факт по идентификатору, и
 * ссылка проверяется. Карточка без валидной ссылки отбрасывается целиком.
 * Это не перестраховка: модель, которой дали шесть фактов и попросили сделать
 * выводы, охотно добавляет седьмой — правдоподобный и выдуманный.
 */

const MAX_CARDS = 3;

export interface DraftCard {
  title: string;
  body: string;
  /** Идентификаторы фактов, на которых карточка стоит. */
  factIds: string[];
  severity: "info" | "warning" | "opportunity";
}

export async function phraseCards(facts: Fact[]): Promise<DraftCard[]> {
  if (facts.length === 0) return [];

  const catalogue = facts.map((f) => `${f.id}: ${f.text}`).join("\n");

  try {
    const result = await llmChat({
      feature: "finance.insights",
      preset: "cheap",
      maxTokens: 700,
      messages: [
        {
          role: "system",
          content: [
            "Ты финансовый аналитик владельца бизнеса. Тебе дают ГОТОВЫЕ факты",
            "с числами. Твоя работа — выбрать самое важное и сказать это",
            "человеческим языком.",
            "",
            "Верни СТРОГО JSON:",
            '{"cards": [{"title": "...", "body": "...", "factIds": ["..."], "severity": "info"}]}',
            "",
            `Не больше ${MAX_CARDS} карточек. Каждая ОБЯЗАНА ссылаться минимум на`,
            "один факт по его идентификатору в factIds.",
            "",
            "ЗАПРЕЩЕНО: придумывать числа, которых нет в фактах; пересчитывать",
            "проценты; делать выводы о причинах, которых в фактах нет.",
            "Если фактов мало — верни меньше карточек, это нормально.",
            "",
            "title — до 60 символов. body — 1–2 предложения, по-русски, на «ты».",
            "severity: warning — если это про риск, opportunity — если про",
            "возможность сэкономить или заработать, иначе info.",
            "",
            "Без давления виной и срочностью: показывай цифру и предлагай шаг.",
          ].join("\n"),
        },
        { role: "user", content: `Факты:\n${catalogue}` },
      ],
    });

    return parseCards(result.text, facts);
  } catch (e) {
    // Недоступная модель не должна лишать владельца наблюдений: шаблонные
    // карточки формируются кодом и приезжают независимо.
    logWarn("finance.insights_phrasing_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

export function parseCards(raw: string, facts: Fact[]): DraftCard[] {
  const known = new Set(facts.map((f) => f.id));

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return [];

  let parsed: { cards?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as { cards?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.cards)) return [];

  const cards: DraftCard[] = [];
  for (const item of parsed.cards.slice(0, MAX_CARDS)) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;

    const title = typeof record.title === "string" ? record.title.trim() : "";
    const body = typeof record.body === "string" ? record.body.trim() : "";
    if (title.length < 3 || body.length < 10) continue;

    const rawIds = Array.isArray(record.factIds) ? record.factIds : [];
    const factIds = rawIds.filter((id): id is string => typeof id === "string" && known.has(id));

    // Вот эта строка и есть вся защита. Карточка, не опирающаяся ни на один
    // реальный факт, — это наблюдение, которое модель придумала сама.
    if (factIds.length === 0) continue;

    const severity =
      record.severity === "warning" || record.severity === "opportunity"
        ? record.severity
        : "info";

    cards.push({ title: title.slice(0, 120), body: body.slice(0, 600), factIds, severity });
  }

  return cards;
}
