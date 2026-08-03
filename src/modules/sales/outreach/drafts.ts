import type { OutreachChannel } from "@prisma/client";
import { prisma } from "@/core/db";
import { llmChat } from "@/core/llm";
import { logInfo, logWarn } from "@/core/observability/logger";
import { dayBounds } from "@/core/shared/time";
import { readScoreData } from "../leadgen/scoring";

/**
 * Черновики первого сообщения.
 *
 * Три правила, и все три — про то, что рассылка остаётся ручной.
 *
 * 1. **Система ничего не отправляет.** Черновик копируется или открывается
 *    deep-link'ом в мессенджере. Массовая автоматическая рассылка от лица
 *    владельца ставит под удар и его номер, и репутацию продукта, ради
 *    которого всё делается.
 * 2. **Не больше двадцати в сутки.** Ограничение стоит на СОЗДАНИИ, а не на
 *    отправке: сотня черновиков в очереди — это не «много вариантов», а
 *    очередь, которую никто не разберёт, и повод отправлять не глядя.
 * 3. **Правки владельца хранятся отдельно.** `editedBody` рядом с `body` —
 *    это образцы тона для следующих черновиков, а заодно честный ответ на
 *    вопрос «насколько модель попадает».
 */

/** Потолок черновиков в сутки владельца. */
export const DAILY_DRAFT_CAP = 20;

/** Сколько составляем за один прогон крона. */
const BATCH = 5;

/** Через сколько дней после отправки напомнить, если не ответили. */
const FOLLOW_UP_DAYS = 3;

/** Сколько правок владельца показываем модели как образец тона. */
const TONE_SAMPLES = 3;

export interface DraftRunResult {
  created: number;
  reason?: string;
}

/**
 * Кому писать: лиды без единого касания, лучшие по оценке.
 *
 * Лид, которого уже касались, из выборки исключён целиком — черновик
 * «первого сообщения» тому, с кем разговор идёт, выглядит как забывчивость и
 * стоит дороже, чем не написать вовсе.
 */
async function pickTargets(limit: number) {
  return prisma.lead.findMany({
    where: {
      touchPoints: { none: {} },
      outreach: { none: {} },
      // Без телефона и без сайта писать некуда.
      OR: [{ phoneNormalized: { not: null } }, { contacts: { some: {} } }],
    },
    orderBy: [{ aiScore: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: limit,
    select: {
      id: true,
      name: true,
      city: true,
      niche: true,
      site: true,
      aiScore: true,
      aiScoreData: true,
      phoneNormalized: true,
      contacts: { select: { name: true, telegram: true, phone: true }, take: 1 },
    },
  });
}

export async function generateDrafts(now: Date = new Date()): Promise<DraftRunResult> {
  const today = dayBounds(now);
  const madeToday = await prisma.outreachDraft.count({
    where: { createdAt: { gte: today.start, lt: today.end } },
  });

  const room = DAILY_DRAFT_CAP - madeToday;
  if (room <= 0) return { created: 0, reason: `суточный потолок ${DAILY_DRAFT_CAP} исчерпан` };

  const targets = await pickTargets(Math.min(BATCH, room));
  if (targets.length === 0) return { created: 0, reason: "некому писать" };

  const tone = await recentEdits();

  let created = 0;
  for (const lead of targets) {
    let draft: { body: string; reasoning: string } | null;
    try {
      draft = await composeDraft(lead, tone);
    } catch (e) {
      // Недоступная модель — не повод писать шаблон от её имени: безликое
      // «Здравствуйте, предлагаем сотрудничество» хуже молчания.
      logWarn("sales.outreach_compose_failed", {
        leadId: lead.id,
        error: e instanceof Error ? e.message : String(e),
      });
      break;
    }
    if (!draft) continue;

    await prisma.outreachDraft.create({
      data: {
        leadId: lead.id,
        channel: pickChannel(lead),
        body: draft.body,
        reasoning: draft.reasoning || null,
      },
    });
    created += 1;
  }

  logInfo("sales.outreach_drafted", { created, cap: DAILY_DRAFT_CAP, madeToday });
  return { created };
}

/**
 * Канал по тому, что о лиде известно.
 *
 * Telegram по умолчанию: в нём переписка не выглядит рассылкой. Если известен
 * только номер — WhatsApp по deep-link'у; звонок остаётся, когда писать
 * некуда.
 */
export function pickChannel(lead: {
  contacts: Array<{ telegram: string | null; phone: string | null }>;
  phoneNormalized: string | null;
}): OutreachChannel {
  if (lead.contacts.some((c) => c.telegram)) return "TELEGRAM";
  if (lead.phoneNormalized ?? lead.contacts.some((c) => c.phone)) return "WHATSAPP";
  return "PHONE";
}

/** Последние правки владельца — образцы его тона для промпта. */
async function recentEdits(): Promise<string[]> {
  const edited = await prisma.outreachDraft.findMany({
    where: { editedBody: { not: null } },
    orderBy: { updatedAt: "desc" },
    take: TONE_SAMPLES,
    select: { editedBody: true },
  });
  return edited.map((e) => e.editedBody!).filter(Boolean);
}

async function composeDraft(
  lead: {
    id: string;
    name: string;
    city: string | null;
    niche: string;
    site: string | null;
    aiScore: number | null;
    aiScoreData: unknown;
  },
  tone: string[],
): Promise<{ body: string; reasoning: string } | null> {
  const score = readScoreData(lead.aiScoreData);

  const facts = [
    `название: ${lead.name}`,
    `город: ${lead.city ?? "не указан"}`,
    `сайт: ${lead.site ?? "нет"}`,
    lead.aiScore !== null ? `оценка: ${lead.aiScore}/100` : null,
    score.reasons.length > 0 ? `основания оценки: ${score.reasons.join("; ")}` : null,
    score.fitReason ? `чем интересны: ${score.fitReason}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const result = await llmChat({
    feature: "sales.outreach_draft",
    preset: "smart",
    maxTokens: 500,
    messages: [
      {
        role: "system",
        content: [
          "Ты пишешь ПЕРВОЕ сообщение владельцу автосервиса от лица Максима —",
          "основателя небольшого сервиса онлайн-записи Agentus. Пишет живой",
          "человек, а не отдел продаж.",
          "",
          "Верни СТРОГО JSON: {\"body\": \"...\", \"reasoning\": \"...\"}",
          "",
          "body — само сообщение. Требования:",
          "- 2–4 коротких предложения, не длиннее 400 знаков;",
          "- по-русски, на «вы», без восклицаний и без капса;",
          "- одна конкретная деталь про ИХ сервис из фактов ниже — иначе это",
          "  рассылка, и её видно с первой строки;",
          "- заканчивается вопросом, на который легко ответить одним словом.",
          "",
          "ЗАПРЕЩЕНО: обещать рост выручки и конкретные проценты; писать «мы",
          "лидеры рынка»; называть скидки и сроки, которых нам никто не давал;",
          "выдумывать факты, которых нет ниже; обращаться по имени, если имени",
          "в фактах нет.",
          "",
          "reasoning — одно предложение для владельца: почему написано именно",
          "так. Это ему, не адресату.",
          ...(tone.length > 0
            ? [
                "",
                "Владелец правил прошлые черновики. Держись этого тона:",
                ...tone.map((t) => `— ${t}`),
              ]
            : []),
        ].join("\n"),
      },
      { role: "user", content: facts },
    ],
  });

  return parseDraft(result.text);
}

/** Разбор ответа модели. Пустое или неполное — не черновик, а мусор. */
export function parseDraft(raw: string): { body: string; reasoning: string } | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let parsed: { body?: unknown; reasoning?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as { body?: unknown; reasoning?: unknown };
  } catch {
    return null;
  }

  const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
  // Слишком короткое сообщение — это не «лаконично», это обрыв генерации.
  if (body.length < 40) return null;

  return {
    body: body.slice(0, 600),
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning.trim().slice(0, 300) : "",
  };
}

export { FOLLOW_UP_DAYS };
