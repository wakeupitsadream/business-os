import { prisma } from "@/core/db";
import { llmChat } from "@/core/llm";
import { backfillEmbeddings, recallFacts, saveFact } from "@/core/memory";
import { logInfo, logWarn } from "@/core/observability/logger";
import { dayBounds, dayKey } from "@/core/shared/time";
import type { MemoryCategory } from "@prisma/client";

/**
 * Ночная сводка дня.
 *
 * Существует ради одной вещи: память не должна зависеть от того, вспомнила ли
 * модель вызвать save_memory_fact посреди разговора. Вспоминает она через раз,
 * а теряется при этом самое ценное — сказанное вскользь. «Осенью перееду в
 * Москву», «с этим клиентом больше не работаем» — через месяц именно это
 * отличает секретаря, который в курсе, от секретаря, который каждый раз
 * знакомится заново.
 *
 * Работает на дешёвой модели: качество формулировок здесь второстепенно.
 */

/** Сколько фактов за вечер считаем разумным пределом. */
const MAX_FACTS_PER_DAY = 5;

/**
 * Порог «это уже есть в памяти». Подобран под ту же метрику, что и поиск:
 * 0.25 по косинусу — это перефразировка одной мысли, а не новая.
 */
const DUPLICATE_DISTANCE = 0.25;

export interface DaySummaryResult {
  summarized: boolean;
  factsAdded: number;
  factsSkipped: number;
  embeddingsFilled: number;
  reason?: string;
}

export async function runDaySummary(now: Date = new Date()): Promise<DaySummaryResult> {
  const key = dayKey(now);
  const { start, end } = dayBounds(now);

  const existing = await prisma.journalEntry.findFirst({
    where: { kind: "DAY_SUMMARY", dayKey: key },
    select: { id: true },
  });
  if (existing) {
    // Повторный прогон после рестарта контейнера не должен ни пересказывать
    // день заново, ни — что важнее — извлекать те же факты во второй раз.
    return {
      summarized: false,
      factsAdded: 0,
      factsSkipped: 0,
      embeddingsFilled: 0,
      reason: "сводка за сегодня уже есть",
    };
  }

  const material = await collectDay(start, end);
  if (material.messages.length === 0 && material.events.length === 0) {
    return {
      summarized: false,
      factsAdded: 0,
      factsSkipped: 0,
      embeddingsFilled: await backfill(),
      reason: "за день ничего не происходило",
    };
  }

  const digest = await askModel(material);

  await prisma.journalEntry.create({
    data: {
      kind: "DAY_SUMMARY",
      authoredBy: "ASSISTANT",
      dayKey: key,
      title: `День ${key}`,
      content: digest.summary,
    },
  });

  const { added, skipped } = await storeFacts(digest.facts);
  const embeddingsFilled = await backfill();

  logInfo("day_summary.done", { dayKey: key, added, skipped, embeddingsFilled });
  return {
    summarized: true,
    factsAdded: added,
    factsSkipped: skipped,
    embeddingsFilled,
  };
}

interface DayMaterial {
  messages: Array<{ role: string; content: string }>;
  events: Array<{ title: string }>;
  doneTasks: Array<{ title: string }>;
}

async function collectDay(start: Date, end: Date): Promise<DayMaterial> {
  const [messages, events, doneTasks] = await Promise.all([
    prisma.message.findMany({
      where: { createdAt: { gte: start, lt: end }, role: { in: ["USER", "ASSISTANT"] } },
      orderBy: { createdAt: "asc" },
      take: 120,
      select: { role: true, content: true },
    }),
    prisma.domainEvent.findMany({
      where: { occurredAt: { gte: start, lt: end }, module: { not: "system" } },
      orderBy: { occurredAt: "asc" },
      take: 30,
      select: { title: true },
    }),
    prisma.task.findMany({
      where: { status: "DONE", completedAt: { gte: start, lt: end } },
      take: 30,
      select: { title: true },
    }),
  ]);

  return {
    messages: messages.map((m) => ({ role: m.role === "USER" ? "владелец" : "Ася", content: m.content })),
    events,
    doneTasks,
  };
}

interface Digest {
  summary: string;
  facts: Array<{ text: string; category: MemoryCategory }>;
}

const CATEGORIES: MemoryCategory[] = [
  "BUSINESS",
  "FINANCE",
  "HEALTH",
  "PSYCHOLOGY",
  "PREFERENCE",
  "GOAL",
  "RELATIONSHIP",
  "HISTORY",
];

async function askModel(material: DayMaterial): Promise<Digest> {
  const result = await llmChat({
    feature: "secretary.day_summary",
    preset: "cheap",
    maxTokens: 900,
    messages: [
      {
        role: "system",
        content: [
          "Ты разбираешь день владельца бизнеса и возвращаешь СТРОГО JSON:",
          '{"summary": "...", "facts": [{"text": "...", "category": "..."}]}',
          "",
          "summary — 2–4 предложения по-русски о том, чем был занят день.",
          "",
          "facts — устойчивые факты о владельце, которые пригодятся ЧЕРЕЗ МЕСЯЦ:",
          "предпочтения, обстоятельства, решения, отношения, цели. Формулируй",
          "от третьего лица одним предложением.",
          "",
          "НЕ включай в facts: разовые дела и задачи, погоду, содержание",
          "сегодняшних сообщений само по себе, вежливые фразы, домыслы.",
          `Максимум ${MAX_FACTS_PER_DAY} фактов. Если устойчивых фактов не было —`,
          "верни пустой массив, это нормальный и частый исход.",
          "",
          `category — одно из: ${CATEGORIES.join(", ")}`,
        ].join("\n"),
      },
      { role: "user", content: JSON.stringify(material) },
    ],
  });

  return parseDigest(result.text);
}

/**
 * Разбор ответа модели. Модель просят вернуть JSON, и она обычно возвращает —
 * но иногда оборачивает в ```json или добавляет пояснение. Сводка дня не тот
 * случай, ради которого стоит падать: вытаскиваем что можем.
 */
export function parseDigest(raw: string): Digest {
  const jsonText = extractJson(raw);
  if (!jsonText) return { summary: raw.trim().slice(0, 2000), facts: [] };

  try {
    const parsed = JSON.parse(jsonText) as {
      summary?: unknown;
      facts?: unknown;
    };

    const summary =
      typeof parsed.summary === "string" && parsed.summary.trim().length > 0
        ? parsed.summary.trim()
        : raw.trim().slice(0, 2000);

    const facts: Digest["facts"] = [];
    if (Array.isArray(parsed.facts)) {
      for (const item of parsed.facts.slice(0, MAX_FACTS_PER_DAY)) {
        if (typeof item !== "object" || item === null) continue;
        const text = (item as { text?: unknown }).text;
        if (typeof text !== "string" || text.trim().length < 3) continue;

        const rawCategory = (item as { category?: unknown }).category;
        const category = CATEGORIES.includes(rawCategory as MemoryCategory)
          ? (rawCategory as MemoryCategory)
          : "HISTORY";

        facts.push({ text: text.trim().slice(0, 500), category });
      }
    }
    return { summary, facts };
  } catch {
    return { summary: raw.trim().slice(0, 2000), facts: [] };
  }
}

function extractJson(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

/**
 * Запись фактов с обязательным дедупом.
 *
 * Без него каждый вечер память пополняется пересказом одного и того же:
 * «работает из Казани» приезжает тридцать раз за месяц, вытесняет из top-K
 * всё остальное, и поиск начинает возвращать один и тот же факт в трёх
 * формулировках.
 */
async function storeFacts(
  facts: Array<{ text: string; category: MemoryCategory }>,
): Promise<{ added: number; skipped: number }> {
  let added = 0;
  let skipped = 0;

  for (const fact of facts) {
    if (await isDuplicate(fact.text)) {
      skipped += 1;
      continue;
    }
    try {
      await saveFact({ ...fact, source: "day-summary" });
      added += 1;
    } catch (e) {
      logWarn("day_summary.fact_save_failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { added, skipped };
}

async function isDuplicate(text: string): Promise<boolean> {
  // Векторный путь: близкий по смыслу факт уже есть.
  const similar = await recallFacts(text, { limit: 3, maxDistance: DUPLICATE_DISTANCE });
  if (similar.some((f) => f.via === "vector")) return true;

  // Без эмбеддингов вектор ничего не скажет — сверяем нормализованный текст.
  // Грубо, но ловит буквальные повторы, а это основная масса дублей.
  const normalized = normalize(text);
  const recent = await prisma.memoryFact.findMany({
    where: { active: true },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { text: true },
  });
  return recent.some((f) => normalize(f.text) === normalized);
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ё]/g, "е")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Дозаполнение векторов у фактов, сохранённых без них. */
async function backfill(): Promise<number> {
  try {
    const { done } = await backfillEmbeddings(20);
    return done;
  } catch (e) {
    logWarn("day_summary.backfill_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return 0;
  }
}
