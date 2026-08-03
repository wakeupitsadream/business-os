import type { ContentRubric } from "@prisma/client";
import { prisma } from "@/core/db";
import { LlmUnavailableError, llmChat } from "@/core/llm";
import { logInfo, logWarn } from "@/core/observability/logger";
import { OWNER_TZ, weekBounds, weekKey } from "@/core/shared/time";
import { TZDate } from "@date-fns/tz";

/**
 * Недельный план контента.
 *
 * Граница ответственности та же, что у брифа: КОД считает всё, что можно
 * посчитать — какие дни свободны, в каком часу выходит пост, какие рубрики
 * недобраны, о чём уже писали, — а модель только придумывает темы. Даты и
 * рубрики модели не доверяются: даты она выдумывает охотно, а рубрики скашивает
 * в одну, и то и другое считается кодом в три строки.
 */

/** Сколько идей в неделю. Меньше — план не план, больше — владелец не потянет. */
const SLOTS = 4;

/** Часы публикации по времени владельца: утро и вечер. */
const SLOT_HOURS = [10, 19];

/** Сколько прошлых заголовков показываем модели для антиповтора. */
const RECENT_FOR_PROMPT = 20;

/** Сколько одобренных постов идут в few-shot как образцы тона. */
const TONE_SAMPLES = 3;

/** Порог схожести заголовков, выше которого считаем тему повтором. */
const SIMILARITY = 0.45;

const ALL_RUBRICS: ContentRubric[] = ["CASE", "NICHE_PAIN", "FEATURE", "BEHIND_SCENES", "DIGEST"];

export interface PlanSlot {
  /** Порядковый номер в плане — по нему сверяется ответ модели. */
  slotId: number;
  scheduledAt: Date;
  rubric: ContentRubric;
}

export interface PlanResult {
  planKey: string;
  created: number;
  /** План собран без модели: шлюзы лежали или дневной бюджет исчерпан. */
  degraded: boolean;
  /** Уже существовал — второй клик ничего не создал. */
  existed: boolean;
}

/**
 * Слоты недели. Считает КОД.
 *
 * Дни выбираются через один, начиная с понедельника: ежедневный поток соло-
 * основатель не тянет, а два поста подряд с одной рубрикой читаются как спам.
 */
export function planSlots(now: Date, tz: string = OWNER_TZ): PlanSlot[] {
  const { start } = weekBounds(now, tz);
  const slots: PlanSlot[] = [];

  for (let i = 0; i < SLOTS; i += 1) {
    const dayOffset = i * 2; // Пн, Ср, Пт, Вс
    const hour = SLOT_HOURS[i % SLOT_HOURS.length] ?? 10;
    const local = new TZDate(start, tz);
    const at = new TZDate(
      local.getFullYear(),
      local.getMonth(),
      local.getDate() + dayOffset,
      hour,
      0,
      0,
      0,
      tz,
    );
    slots.push({ slotId: i + 1, scheduledAt: new Date(at.getTime()), rubric: "CASE" });
  }
  return slots;
}

/**
 * Разложить рубрики по слотам так, чтобы недобранные шли первыми.
 *
 * Баланс держит код, а не модель: попроси её «разнообразить рубрики» — и она
 * стабильно скатывается в кейсы, потому что про них проще придумать.
 */
export function balanceRubrics(slots: PlanSlot[], recent: ContentRubric[]): PlanSlot[] {
  const used = new Map<ContentRubric, number>();
  for (const r of ALL_RUBRICS) used.set(r, 0);
  for (const r of recent) used.set(r, (used.get(r) ?? 0) + 1);

  const order = [...ALL_RUBRICS].sort((a, b) => (used.get(a) ?? 0) - (used.get(b) ?? 0));
  return slots.map((s, i) => ({ ...s, rubric: order[i % order.length] ?? "CASE" }));
}

/** Заголовки последних постов — и для промпта, и для проверки на повтор. */
async function recentTitles(limit: number): Promise<Array<{ title: string; rubric: ContentRubric }>> {
  const rows = await prisma.contentPost.findMany({
    where: { status: { in: ["APPROVED", "SCHEDULED", "PUBLISHED"] } },
    orderBy: { createdAt: "desc" },
    take: limit,
    // Только заголовок и рубрика: двадцать полных текстов — это тысячи входных
    // токенов на каждый запуск, а для «не повторяйся» их содержание не нужно.
    select: { title: true, rubric: true },
  });
  return rows;
}

/** Образцы тона: то, что владелец одобрил или переписал сам. */
async function toneSamples(): Promise<string[]> {
  const rows = await prisma.contentPost.findMany({
    where: { status: { in: ["APPROVED", "SCHEDULED", "PUBLISHED"] }, body: { not: null } },
    orderBy: { updatedAt: "desc" },
    take: TONE_SAMPLES,
    select: { body: true, editedBody: true },
  });
  return rows
    .map((r) => (r.editedBody ?? r.body ?? "").trim())
    .filter((t) => t.length > 0)
    .map((t) => t.slice(0, 600));
}

/**
 * Похожа ли тема на то, о чём уже писали.
 *
 * Второй уровень антиповтора, кодовый. Первый — инструкция в промпте, но такие
 * запреты модели выполняют ненадёжно: «Как автосервис перестал терять заявки»
 * и «Автосервис: заявки больше не теряются» для неё разные темы.
 */
export function looksRepeated(title: string, recent: string[]): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3);

  const words = new Set(norm(title));
  if (words.size === 0) return false;

  for (const other of recent) {
    const otherWords = new Set(norm(other));
    if (otherWords.size === 0) continue;
    let shared = 0;
    for (const w of words) if (otherWords.has(w)) shared += 1;
    const score = shared / Math.min(words.size, otherWords.size);
    if (score >= SIMILARITY) return true;
  }
  return false;
}

/** Запасной заголовок, когда модель недоступна. */
const FALLBACK_TITLE: Record<ContentRubric, string> = {
  CASE: "Кейс недели: что изменилось у клиента",
  NICHE_PAIN: "Боль ниши: узнаваемая ситуация",
  FEATURE: "Что нового в продукте",
  BEHIND_SCENES: "Как это устроено изнутри",
  DIGEST: "Дайджест: что было за период",
};

interface Idea {
  slotId: number;
  title: string;
  reasoning: string;
}

/** Ответ модели: строго JSON, чужие слоты отбрасываются. */
export function parseIdeas(raw: string, known: Set<number>): Idea[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: Idea[] = [];
  const seen = new Set<number>();
  for (const item of parsed) {
    const o = item as { slotId?: unknown; title?: unknown; reasoning?: unknown };
    const slotId = typeof o.slotId === "number" ? o.slotId : Number(o.slotId);
    const title = typeof o.title === "string" ? o.title.trim() : "";

    // Модель, получившая четыре слота, охотно возвращает пятый — правдоподобный
    // и выдуманный. Тот же урок, что и в скоринге кандидатов.
    if (!Number.isInteger(slotId) || !known.has(slotId) || seen.has(slotId)) continue;
    // Слишком короткий заголовок — это не лаконичность, а обрыв генерации.
    if (title.length < 10) continue;

    seen.add(slotId);
    out.push({
      slotId,
      title: title.slice(0, 200),
      reasoning: typeof o.reasoning === "string" ? o.reasoning.trim().slice(0, 400) : "",
    });
  }
  return out;
}

async function generateIdeas(
  slots: PlanSlot[],
  recent: Array<{ title: string; rubric: ContentRubric }>,
  samples: string[],
): Promise<Idea[]> {
  const slotLines = slots
    .map((s) => `${s.slotId}. рубрика ${s.rubric}`)
    .join("\n");
  const recentLines = recent.length
    ? recent.map((r) => `• [${r.rubric}] ${r.title}`).join("\n")
    : "(постов ещё не было)";
  const sampleBlock = samples.length
    ? samples.map((s, i) => `--- образец ${i + 1} ---\n${s}`).join("\n\n")
    : "(образцов ещё нет)";

  const result = await llmChat({
    feature: "sales.content_plan",
    preset: "smart",
    maxTokens: 900,
    messages: [
      {
        role: "system",
        content: [
          "Ты помогаешь владельцу SaaS Agentus вести телеграм-канал о продукте и о том,",
          "как он строит бизнес в одиночку. Придумай темы постов на неделю.",
          "",
          "Правила:",
          "- Русский язык, живой и конкретный. Без канцелярита и без «В современном мире».",
          "- Заголовок — одна строка, 30–90 символов, обещающая конкретику.",
          "- Рубрику НЕ выбираешь: она задана для каждого слота, тему придумываешь под неё.",
          "- Даты НЕ называешь: их считает система.",
          "- Не повторяй темы, о которых уже писали (список ниже). Похожая формулировка",
          "  той же мысли — это повтор.",
          "",
          "Ответ — ТОЛЬКО JSON-массив, без пояснений вокруг:",
          '[{"slotId": 1, "title": "…", "reasoning": "почему эта тема сейчас"}]',
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          "Слоты недели:",
          slotLines,
          "",
          "Уже писали:",
          recentLines,
          "",
          "Образцы тона (так владелец пишет сам):",
          sampleBlock,
        ].join("\n"),
      },
    ],
  });

  return parseIdeas(result.text, new Set(slots.map((s) => s.slotId)));
}

/**
 * Собрать план недели. Идемпотентно по ключу недели: второй клик видит, что
 * план уже есть, и ничего не создаёт.
 */
export async function buildWeeklyPlan(now: Date = new Date()): Promise<PlanResult> {
  const key = weekKey(now);

  const existing = await prisma.contentPost.count({ where: { planKey: key } });
  if (existing > 0) {
    return { planKey: key, created: 0, degraded: false, existed: true };
  }

  const recent = await recentTitles(RECENT_FOR_PROMPT);
  const slots = balanceRubrics(planSlots(now), recent.map((r) => r.rubric));

  let ideas: Idea[] = [];
  let degraded = false;
  try {
    const samples = await toneSamples();
    ideas = await generateIdeas(slots, recent, samples);
    if (ideas.length === 0) {
      // Модель ответила, но разобрать нечего — то же самое, что недоступна.
      degraded = true;
      logWarn("content.plan_unparsable", { planKey: key });
    }
  } catch (e) {
    // План всё равно должен получиться: слоты, даты и рубрики целиком считает
    // код, и отказ кнопки здесь ни от чего не защищает — в отличие от скоринга,
    // где деградированный балл неотличим от настоящего, пустая тема видна как
    // пустая. Но владелец обязан знать, что модели не было: иначе он решит, что
    // ИИ выдаёт мусор, и перестанет нажимать кнопку.
    degraded = true;
    if (!(e instanceof LlmUnavailableError)) throw e;
    logWarn("content.plan_llm_unavailable", { planKey: key, error: e.message });
  }

  const recentTitleList = recent.map((r) => r.title);
  const bySlot = new Map(ideas.map((i) => [i.slotId, i]));
  const groupKey = `plan_${key}`;

  let created = 0;
  for (const slot of slots) {
    const idea = bySlot.get(slot.slotId);
    const repeated = idea ? looksRepeated(idea.title, recentTitleList) : false;

    await prisma.contentPost.create({
      data: {
        channel: "TELEGRAM",
        status: "IDEA",
        rubric: slot.rubric,
        groupKey: `${groupKey}_${slot.slotId}`,
        title: idea && !repeated ? idea.title : FALLBACK_TITLE[slot.rubric],
        reasoning: repeated
          ? "Тема, предложенная моделью, слишком похожа на недавнюю — заменена заготовкой."
          : (idea?.reasoning ?? null),
        degraded: degraded || !idea || repeated,
        planKey: key,
        scheduledAt: slot.scheduledAt,
      },
    });
    created += 1;
    if (repeated) logInfo("content.plan_repeat_rejected", { planKey: key, title: idea?.title });
  }

  logInfo("content.plan_built", { planKey: key, created, degraded });
  return { planKey: key, created, degraded, existed: false };
}
