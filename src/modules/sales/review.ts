import { prisma } from "@/core/db";
import { LlmUnavailableError, llmChat } from "@/core/llm";
import { logInfo, logWarn } from "@/core/observability/logger";
import { formatKop } from "@/core/shared/money";
import { collectReviewMetrics, lastWeekBounds, type ReviewMetrics } from "./review-metrics";
import { scheduleFollowUp } from "./leads";

/**
 * Еженедельный разбор продаж.
 *
 * Цифры и текст лежат в разных колонках намеренно: на вопрос «откуда эта
 * цифра» всегда должен быть ответ, не зависящий от того, что написала модель.
 * Модель получает готовые числа и не имеет возможности назвать своё.
 */

/** Сколько действий недели просим. Больше трёх владелец за неделю не сделает. */
const ACTIONS = 3;

export interface ReviewResult {
  weekKey: string;
  created: boolean;
  degraded: boolean;
}

/** Разбор, готовый к показу. */
export interface ReviewCard {
  id: string;
  weekKey: string;
  metrics: ReviewMetrics;
  report: string | null;
  degraded: boolean;
  actions: ReviewAction[];
  actionsTaken: Record<string, string>;
}

export interface ReviewAction {
  key: string;
  text: string;
}

/** Сухая сводка цифр — она же запасной отчёт, когда модель недоступна. */
export function renderMetricsPlain(m: ReviewMetrics): string {
  const lines: string[] = [];

  lines.push(`Неделя ${m.weekKey}.`);
  lines.push(
    `Новых лидов: ${m.leadsCreated}. Сделок заведено: ${m.dealsCreated}, выиграно: ${m.dealsWon}, проиграно: ${m.dealsLost}.`,
  );
  if (m.wonAmountKop > 0) lines.push(`Выиграно на сумму: ${formatKop(m.wonAmountKop)} в месяц.`);

  const withRate = m.conversions.filter((c) => c.rate !== null);
  if (withRate.length > 0) {
    lines.push("", "Конверсии по стадиям:");
    for (const c of withRate) {
      lines.push(`• ${c.fromStageName}: ${c.advanced} из ${c.entered} (${Math.round((c.rate ?? 0) * 100)}%)`);
    }
  } else if (m.conversions.length > 0) {
    // Проценты на двух сделках — не метрика, а шум, и хуже: они читаются как
    // факт и провоцируют решения.
    lines.push("", "Конверсии не считаем: данных за неделю слишком мало.");
  }

  if (m.lostReasons.length > 0) {
    lines.push("", "Причины проигрыша:");
    for (const r of m.lostReasons) lines.push(`• ${r.reason}: ${r.count}`);
  }

  if (m.stale.length > 0) {
    lines.push("", "Застряли:");
    for (const s of m.stale) lines.push(`• ${s.stageName}: ${s.count} (дольше всех — ${s.maxDays} дн.)`);
  }

  lines.push(
    "",
    `Обещано касаний: ${m.touches.promised}, выполнено: ${m.touches.done}, пропущено: ${m.touches.skipped}, просрочено сейчас: ${m.touches.overdue}.`,
  );

  return lines.join("\n");
}

/** Разбор ответа модели. Действия отделяются от текста, чтобы стать кнопками. */
export function parseReport(raw: string): { report: string; actions: ReviewAction[] } | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let parsed: { report?: unknown; actions?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as { report?: unknown; actions?: unknown };
  } catch {
    return null;
  }

  const report = typeof parsed.report === "string" ? parsed.report.trim() : "";
  if (report.length < 40) return null; // обрыв генерации, а не лаконичность

  const actions: ReviewAction[] = [];
  if (Array.isArray(parsed.actions)) {
    for (const [i, item] of parsed.actions.entries()) {
      const text = typeof item === "string" ? item.trim() : "";
      if (text.length < 5 || actions.length >= ACTIONS) continue;
      // Ключ от ПОЗИЦИИ, а не от текста: по нему кнопка помнит, что её уже
      // нажимали, и текст действия для этого не должен совпадать посимвольно.
      actions.push({ key: `a${i + 1}`, text: text.slice(0, 200) });
    }
  }

  return { report, actions };
}

async function interpret(m: ReviewMetrics): Promise<{ report: string; actions: ReviewAction[] }> {
  const result = await llmChat({
    feature: "sales.weekly_review",
    preset: "smart",
    maxTokens: 900,
    messages: [
      {
        role: "system",
        content: [
          "Ты разбираешь неделю продаж для владельца SaaS, который работает один.",
          "",
          "Правила:",
          "- Русский язык, по-деловому и без воды. Обращение на «ты».",
          "- Числа бери ТОЛЬКО из данных. Не считай свои, не округляй, не додумывай.",
          "- Если сказано, что данных мало, — так и скажи, а не выдавай проценты.",
          "- Три вывода, одно узкое место, три действия на неделю. Действия —",
          "  конкретные и выполнимые за неделю одним человеком.",
          "- Идея удержания отдельной строкой, если в данных есть за что зацепиться.",
          "",
          "Ответ — ТОЛЬКО JSON:",
          '{"report": "текст разбора", "actions": ["действие 1", "действие 2", "действие 3"]}',
        ].join("\n"),
      },
      { role: "user", content: renderMetricsPlain(m) },
    ],
  });

  const parsed = parseReport(result.text);
  if (!parsed) throw new LlmUnavailableError("разбор не удалось прочитать");
  return parsed;
}

/**
 * Собрать разбор прошлой недели.
 *
 * Идемпотентно: повторный прогон переписывает отчёт той же недели, а не
 * заводит второй. Отметки о нажатых кнопках при этом сохраняются — иначе
 * перезапуск крона заставил бы владельца заводить те же задачи снова.
 */
export async function buildWeeklyReview(now: Date = new Date()): Promise<ReviewResult> {
  const metrics = await collectReviewMetrics(now);
  const { start } = lastWeekBounds(now);

  let report = renderMetricsPlain(metrics);
  let actions: ReviewAction[] = [];
  let degraded = true;

  try {
    const interpreted = await interpret(metrics);
    report = interpreted.report;
    actions = interpreted.actions;
    degraded = false;
  } catch (e) {
    // Отчёт с цифрами без интерпретации — полезен: конверсии, застрявшие и
    // дисциплина касаний это и есть содержание разбора, а выводы владелец
    // сделает сам. Молча выдавать его за полноценный нельзя.
    if (!(e instanceof LlmUnavailableError)) throw e;
    logWarn("review.llm_unavailable", { weekKey: metrics.weekKey, error: e.message });
  }

  const existing = await prisma.salesReview.findUnique({
    where: { weekStart: start },
    select: { id: true },
  });

  await prisma.salesReview.upsert({
    where: { weekStart: start },
    create: {
      weekStart: start,
      weekKey: metrics.weekKey,
      metrics: { ...metrics, actions } as unknown as object,
      report,
      degraded,
    },
    update: {
      weekKey: metrics.weekKey,
      metrics: { ...metrics, actions } as unknown as object,
      report,
      degraded,
      // actionsTaken НЕ трогаем: заведённые задачи остаются заведёнными.
    },
  });

  logInfo("review.built", { weekKey: metrics.weekKey, degraded, actions: actions.length });
  return { weekKey: metrics.weekKey, created: !existing, degraded };
}

/** Последний разбор для карточки на экране. */
export async function loadLatestReview(): Promise<ReviewCard | null> {
  const row = await prisma.salesReview.findFirst({
    orderBy: { weekStart: "desc" },
    select: {
      id: true,
      weekKey: true,
      metrics: true,
      report: true,
      degraded: true,
      actionsTaken: true,
    },
  });
  if (!row) return null;

  const metrics = row.metrics as unknown as ReviewMetrics & { actions?: ReviewAction[] };
  return {
    id: row.id,
    weekKey: row.weekKey,
    metrics,
    report: row.report,
    degraded: row.degraded,
    actions: Array.isArray(metrics.actions) ? metrics.actions : [],
    actionsTaken: (row.actionsTaken as Record<string, string>) ?? {},
  };
}

export class ReviewError extends Error {
  constructor(
    message: string,
    readonly code: "state" | "input" | "notfound" = "state",
  ) {
    super(message);
    this.name = "ReviewError";
  }
}

/**
 * Превратить действие недели в обещание.
 *
 * `FollowUp` привязан к лиду — это не ограничение схемы, а свойство модели:
 * обещание всегда кому-то. Действие вроде «прозвонить застрявшие» лида не
 * называет, поэтому владелец выбирает его сам, а кнопка сохраняет отметку,
 * чтобы второй клик не завёл второе обещание.
 */
export async function takeAction(
  reviewId: string,
  actionKey: string,
  leadId: string,
  now: Date = new Date(),
): Promise<string> {
  const review = await prisma.salesReview.findUnique({
    where: { id: reviewId },
    select: { metrics: true, actionsTaken: true },
  });
  if (!review) throw new ReviewError("Разбор не найден.", "notfound");

  const taken = (review.actionsTaken as Record<string, string>) ?? {};
  const already = taken[actionKey];
  if (already) return already;

  const metrics = review.metrics as unknown as { actions?: ReviewAction[] };
  const action = metrics.actions?.find((a) => a.key === actionKey);
  if (!action) throw new ReviewError("Такого действия в разборе нет.", "input");

  const followUp = await scheduleFollowUp({
    leadId,
    dueAt: now,
    note: action.text,
    origin: "AI_SUGGESTION",
  });

  // Отметка кладётся ПОСЛЕ создания: потеряв её, мы дадим завести обещание
  // второй раз — неприятно, но поправимо. В обратном порядке действие могло бы
  // числиться выполненным, не будучи заведённым вовсе.
  const updated = await prisma.salesReview.updateMany({
    where: { id: reviewId },
    data: { actionsTaken: { ...taken, [actionKey]: followUp.followUpId } as unknown as object },
  });
  if (updated.count !== 1) logWarn("review.action_mark_failed", { reviewId, actionKey });

  return followUp.followUpId;
}

/** Сжатая версия для утреннего брифа: две строки, не больше. */
export function briefLine(card: ReviewCard | null): string | null {
  if (!card) return null;
  const m = card.metrics;
  const parts = [`Разбор недели ${card.weekKey}: выиграно ${m.dealsWon}, проиграно ${m.dealsLost}`];
  if (m.stale.length > 0) {
    const total = m.stale.reduce((s, x) => s + x.count, 0);
    parts.push(`застряло ${total}`);
  }
  if (m.touches.overdue > 0) parts.push(`просрочено касаний ${m.touches.overdue}`);
  return parts.join(", ") + ".";
}
