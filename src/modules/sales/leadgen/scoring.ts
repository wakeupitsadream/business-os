import { prisma } from "@/core/db";
import { llmChat } from "@/core/llm";
import { logInfo, logWarn } from "@/core/observability/logger";
import { probeSite } from "./site-probe";

/**
 * Скоринг кандидатов лидогена.
 *
 * **Число считает КОД, модель только читает страницу.** Это то же правило, по
 * которому цифры на KPI-карточках не приходят из модели: оценка, которую
 * модель назвала сама, непроверяема — «почему 72» на неё не спросишь, а
 * доверять непрозрачному числу при выборе, кому звонить, нельзя. Поэтому
 * модель отвечает на вопросы, которые требуют чтения («есть ли на сайте
 * онлайн-запись»), а балл складывается из её ответов по формуле ниже.
 *
 * Главный сигнал — ОТСУТСТВИЕ онлайн-записи при живом потоке отзывов. Это и
 * есть портрет клиента Agentus: людей у него достаточно, а записывает он их
 * руками по телефону.
 *
 * Чего здесь нет: «отвечает ли на отзывы». Geosearch отдаёт только их число,
 * не тексты, а с главной страницы это не видно. Заводить сигнал, который
 * всегда false, значит делать вид, что мы его учли.
 */

export interface CandidateSignals {
  hasSite: boolean;
  siteReachable: boolean;
  /** none — сайта нет или он лежит. Остальное читает модель. */
  siteQuality: "none" | "poor" | "ok" | "good";
  hasOnlineBooking: boolean;
  socialActivity: boolean;
  reviewsCount: number;
  rating: number | null;
}

export interface ScorePart {
  label: string;
  points: number;
}

/** Балл, с которого кандидат попадает в «горячие». */
export const HOT_SCORE = 60;

/**
 * Формула. Сумма максимумов — ровно 100, и каждое слагаемое названо словами:
 * разложение сохраняется в `scoreData`, чтобы на «почему 72» был ответ.
 */
export function computeScore(signals: CandidateSignals): {
  score: number;
  breakdown: ScorePart[];
} {
  const parts: ScorePart[] = [{ label: "база", points: 30 }];

  if (signals.reviewsCount >= 50) parts.push({ label: "поток отзывов", points: 20 });
  else if (signals.reviewsCount >= 20) parts.push({ label: "отзывы регулярны", points: 14 });
  else if (signals.reviewsCount >= 5) parts.push({ label: "отзывы есть", points: 7 });

  if (signals.rating !== null && signals.rating >= 4) {
    parts.push({ label: "рейтинг живой", points: 5 });
  }

  // Ради этой строки скоринг и существует: поток есть, записи нет.
  if (!signals.hasOnlineBooking) parts.push({ label: "нет онлайн-записи", points: 28 });

  if (!signals.hasSite || !signals.siteReachable) {
    parts.push({ label: "цифрового присутствия нет", points: 8 });
  } else if (signals.siteQuality === "poor") {
    parts.push({ label: "сайт слабый", points: 12 });
  } else if (signals.siteQuality === "ok") {
    parts.push({ label: "сайт средний", points: 8 });
  } else if (signals.siteQuality === "good") {
    parts.push({ label: "сайт сильный", points: 3 });
  }

  if (signals.socialActivity) parts.push({ label: "ведёт соцсети", points: 5 });

  let score = Math.min(100, Math.max(0, parts.reduce((sum, p) => sum + p.points, 0)));

  /**
   * Потолок для тех, у кого запись уже есть.
   *
   * Отдельным правилом, а не подбором коэффициентов: сервис с потоком отзывов,
   * рейтингом 4.9 и работающей онлайн-записью набирал по сумме слагаемых
   * достаточно, чтобы попасть в «горячие», — а продавать ему нечего, он уже
   * сделал то, что мы предлагаем. Подкрутить константы до нужной арифметики
   * можно, но тогда правило жило бы в числах и сломалось бы при первой же
   * правке весов.
   */
  if (signals.hasOnlineBooking && score >= HOT_SCORE) {
    parts.push({ label: "онлайн-запись уже есть", points: HOT_SCORE - 1 - score });
    score = HOT_SCORE - 1;
  }

  return { score, breakdown: parts };
}

export interface StoredScore {
  reasons: string[];
  fitReason: string | null;
  suggestedPitch: string | null;
}

/**
 * Чтение сохранённой оценки — терпимое к формату.
 *
 * Веса формулы будут меняться, и старые записи останутся с прежним
 * разложением. Показать то, что понятно, и промолчать об остальном лучше, чем
 * уронить экран из-за поля, которого мы больше не пишем.
 */
export function readScoreData(raw: unknown): StoredScore {
  const empty: StoredScore = { reasons: [], fitReason: null, suggestedPitch: null };
  if (typeof raw !== "object" || raw === null) return empty;

  const record = raw as Record<string, unknown>;
  const reasons = Array.isArray(record.reasons)
    ? record.reasons.filter((r): r is string => typeof r === "string").slice(0, 10)
    : [];

  return {
    reasons,
    fitReason: typeof record.fitReason === "string" && record.fitReason ? record.fitReason : null,
    suggestedPitch:
      typeof record.suggestedPitch === "string" && record.suggestedPitch
        ? record.suggestedPitch
        : null,
  };
}

interface LlmVerdict {
  siteQuality: "poor" | "ok" | "good";
  hasOnlineBooking: boolean;
  socialActivity: boolean;
  fitReason: string;
  suggestedPitch: string;
}

export interface ScoreRunResult {
  scored: number;
  skipped: number;
  reason?: string;
  /** true — кандидатов нет вовсе: курсору можно спать. */
  idle?: boolean;
}

/** Сколько кандидатов берём за раз: тик крона не должен стоить дорого. */
const BATCH = 6;

export async function scoreCandidates(limit = BATCH): Promise<ScoreRunResult> {
  const candidates = await prisma.parsedCompany.findMany({
    where: { status: "NEW", score: null },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      name: true,
      city: true,
      address: true,
      site: true,
      rating: true,
      reviewsCount: true,
      niche: true,
    },
  });

  if (candidates.length === 0) return { scored: 0, skipped: 0, reason: "нечего оценивать", idle: true };

  const probed = await Promise.all(
    candidates.map(async (c) => ({ candidate: c, probe: await probeSite(c.site) })),
  );

  let verdicts: Map<string, LlmVerdict>;
  try {
    verdicts = await askModel(probed);
  } catch (e) {
    // Без модели балл не выставляем вовсе. Оценка, собранная без главного
    // сигнала, выглядела бы такой же цифрой, как настоящая, и увела бы
    // владельца звонить не тем.
    logWarn("sales.scoring_unavailable", { error: e instanceof Error ? e.message : String(e) });
    return { scored: 0, skipped: candidates.length, reason: "модель недоступна" };
  }

  let scored = 0;
  for (const { candidate, probe } of probed) {
    const verdict = verdicts.get(candidate.id);
    if (!verdict) continue;

    const signals: CandidateSignals = {
      hasSite: Boolean(candidate.site),
      siteReachable: probe.ok,
      siteQuality: probe.ok ? verdict.siteQuality : "none",
      hasOnlineBooking: probe.ok ? verdict.hasOnlineBooking : false,
      socialActivity: verdict.socialActivity,
      reviewsCount: candidate.reviewsCount ?? 0,
      rating: candidate.rating,
    };

    const { score, breakdown } = computeScore(signals);

    await prisma.parsedCompany.update({
      where: { id: candidate.id },
      data: {
        score,
        scoreData: {
          signals: { ...signals },
          breakdown: breakdown.map((p) => ({ ...p })),
          // `reasons` читает карточка лида — формат общий с ней.
          reasons: breakdown.map((p) => `${p.label}: +${p.points}`),
          fitReason: verdict.fitReason,
          suggestedPitch: verdict.suggestedPitch,
          site: probe.ok ? "probed" : probe.reason,
        },
      },
    });
    scored += 1;
  }

  logInfo("sales.candidates_scored", { scored, of: candidates.length });
  return { scored, skipped: candidates.length - scored };
}

async function askModel(
  batch: Array<{
    candidate: { id: string; name: string; city: string | null; site: string | null };
    probe: Awaited<ReturnType<typeof probeSite>>;
  }>,
): Promise<Map<string, LlmVerdict>> {
  const catalogue = batch
    .map(({ candidate, probe }) =>
      [
        `id: ${candidate.id}`,
        `название: ${candidate.name}`,
        `город: ${candidate.city ?? "не указан"}`,
        `сайт: ${candidate.site ?? "нет"}`,
        probe.ok
          ? `текст главной страницы: ${probe.text}`
          : `страница недоступна (${probe.reason})`,
      ].join("\n"),
    )
    .join("\n---\n");

  const result = await llmChat({
    feature: "sales.candidate_scoring",
    preset: "cheap",
    maxTokens: 1200,
    messages: [
      {
        role: "system",
        content: [
          "Ты помогаешь оценить автосервисы как потенциальных клиентов сервиса",
          "онлайн-записи. Тебе дают карточку компании и текст её главной",
          "страницы. Твоя работа — ответить на три вопроса по КАЖДОЙ и коротко",
          "объяснить, чем она интересна.",
          "",
          "Верни СТРОГО JSON без пояснений:",
          '{"items": [{"id": "...", "siteQuality": "poor|ok|good",',
          '  "hasOnlineBooking": false, "socialActivity": false,',
          '  "fitReason": "...", "suggestedPitch": "..."}]}',
          "",
          "hasOnlineBooking — есть ли на странице запись онлайн: форма записи,",
          "выбор времени, кнопка «записаться». Телефон и мессенджер записью НЕ",
          "считаются: это и есть ручная работа, которую мы заменяем.",
          "socialActivity — есть ли ссылки на живые соцсети или канал.",
          "siteQuality — poor: визитка на конструкторе, ничего не обновлялось;",
          "ok: рабочий сайт с услугами; good: современный сайт с ценами и",
          "записью.",
          "",
          "ЗАПРЕЩЕНО: выставлять баллы или оценки — их считает не ты.",
          "ЗАПРЕЩЕНО: придумывать факты, которых нет в тексте страницы. Если",
          "страница недоступна, ставь siteQuality «poor» и отвечай по названию.",
          "",
          "fitReason — одно предложение, по-русски, чем эта компания нам",
          "интересна. suggestedPitch — одна фраза, с которой стоит начать",
          "разговор. Без давления и без обещаний, которых мы не даём.",
          "",
          "id возвращай ТОЧНО так, как получил. Пропусти компанию, если",
          "сказать о ней нечего.",
        ].join("\n"),
      },
      { role: "user", content: catalogue },
    ],
  });

  return parseVerdicts(result.text, new Set(batch.map((b) => b.candidate.id)));
}

/**
 * Разбор ответа модели.
 *
 * Идентификатор сверяется со списком отправленных — ровно как в карточках
 * финансовых наблюдений. Модель, получившая шесть компаний, охотно возвращает
 * седьмую, правдоподобную и выдуманную.
 */
export function parseVerdicts(raw: string, known: Set<string>): Map<string, LlmVerdict> {
  const out = new Map<string, LlmVerdict>();

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return out;

  let parsed: { items?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as { items?: unknown };
  } catch {
    return out;
  }
  if (!Array.isArray(parsed.items)) return out;

  for (const item of parsed.items) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;

    const id = typeof record.id === "string" ? record.id : "";
    if (!known.has(id) || out.has(id)) continue;

    const quality = record.siteQuality;
    out.set(id, {
      siteQuality: quality === "good" || quality === "ok" ? quality : "poor",
      hasOnlineBooking: record.hasOnlineBooking === true,
      socialActivity: record.socialActivity === true,
      fitReason: typeof record.fitReason === "string" ? record.fitReason.trim().slice(0, 400) : "",
      suggestedPitch:
        typeof record.suggestedPitch === "string" ? record.suggestedPitch.trim().slice(0, 400) : "",
    });
  }

  return out;
}
