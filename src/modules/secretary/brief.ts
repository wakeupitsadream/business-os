import { prisma } from "@/core/db";
import { LlmUnavailableError, llmChat } from "@/core/llm";
import { logError, logInfo, logWarn } from "@/core/observability/logger";
import { tgNotifyOwner } from "@/core/telegram/bot";
import { dayBounds, formatLocal, OWNER_TZ } from "@/core/shared/time";
import { TZDate } from "@date-fns/tz";
import { collectTouchDigest, type TouchDigest } from "@/modules/sales/digest";
import { isInSlump, latestCheckIn } from "./checkin";

/**
 * Утренний бриф.
 *
 * Железное правило: все числа и факты собирает КОД. Модель получает готовую
 * сводку и только формулирует её человеческим языком и выбирает фокус дня.
 * Иначе бриф — единственное, что владелец читает каждое утро, — становится
 * местом, где система уверенно сообщает выдуманные цифры, и доверие к ней
 * заканчивается на первой же замеченной ошибке.
 */

export interface BriefData {
  tasksToday: Array<{ id: string; title: string; dueAt: string | null; priority: number }>;
  overdue: Array<{ id: string; title: string; dueAt: string | null }>;
  reminders: Array<{ text: string; at: string }>;
  yesterdayDone: number;
  events: Array<{ title: string; module: string }>;
  wellbeing: { mood: number | null; energy: number | null; slump: boolean } | null;
  goals: Array<{ title: string; deadline: string | null }>;
  /** Обещанные касания и застрявшие сделки — см. `modules/sales/digest`. */
  sales: TouchDigest;
}

/** Дата брифа — локальная дата владельца, приведённая к полуночи UTC. */
export function briefDate(now: Date, tz: string = OWNER_TZ): Date {
  const local = new TZDate(now, tz);
  return new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate(), 0, 0, 0, 0));
}

/** Детерминированный сбор всего, из чего состоит бриф. */
export async function collectBriefData(now: Date = new Date()): Promise<BriefData> {
  const today = dayBounds(now);
  const yesterday = dayBounds(new Date(now.getTime() - 24 * 3600 * 1000));

  const [tasksToday, overdue, reminders, doneYesterday, events, checkIn, slump, goals, sales] =
    await Promise.all([
      prisma.task.findMany({
        where: {
          status: { in: ["TODO", "IN_PROGRESS"] },
          dueAt: { gte: today.start, lt: today.end },
        },
        orderBy: [{ priority: "asc" }, { dueAt: "asc" }],
        take: 15,
        select: { id: true, title: true, dueAt: true, priority: true },
      }),
      prisma.task.findMany({
        where: { status: { in: ["TODO", "IN_PROGRESS"] }, dueAt: { lt: today.start } },
        orderBy: { dueAt: "asc" },
        take: 10,
        select: { id: true, title: true, dueAt: true },
      }),
      prisma.reminder.findMany({
        where: { isActive: true, nextFireAt: { gte: today.start, lt: today.end } },
        orderBy: { nextFireAt: "asc" },
        take: 10,
        select: { text: true, nextFireAt: true },
      }),
      prisma.task.count({
        where: { status: "DONE", completedAt: { gte: yesterday.start, lt: yesterday.end } },
      }),
      prisma.domainEvent.findMany({
        where: { occurredAt: { gte: yesterday.start, lt: today.end }, module: { not: "system" } },
        orderBy: { occurredAt: "desc" },
        take: 8,
        select: { title: true, module: true },
      }),
      latestCheckIn(),
      isInSlump(now),
      prisma.goal.findMany({
        where: { status: "ACTIVE" },
        orderBy: { deadline: { sort: "asc", nulls: "last" } },
        take: 3,
        select: { title: true, deadline: true },
      }),
      collectTouchDigest(now),
    ]);

  return {
    tasksToday: tasksToday.map((t) => ({
      id: t.id,
      title: t.title,
      dueAt: t.dueAt ? formatLocal(t.dueAt) : null,
      priority: t.priority,
    })),
    overdue: overdue.map((t) => ({
      id: t.id,
      title: t.title,
      dueAt: t.dueAt ? formatLocal(t.dueAt) : null,
    })),
    reminders: reminders.map((r) => ({ text: r.text, at: formatLocal(r.nextFireAt) })),
    yesterdayDone: doneYesterday,
    events: events.map((e) => ({ title: e.title, module: e.module })),
    wellbeing: checkIn
      ? { mood: checkIn.mood, energy: checkIn.energy, slump }
      : null,
    goals: goals.map((g) => ({ title: g.title, deadline: g.deadline ? formatLocal(g.deadline) : null })),
    sales,
  };
}

/**
 * Текст брифа без участия модели.
 *
 * Не «заглушка на случай сбоя», а полноценный запасной вариант: если шлюзы
 * недоступны или лимит расходов исчерпан, бриф всё равно приходит и всё равно
 * полезен — в нём те же самые данные, просто суше.
 */
export function renderBriefPlain(data: BriefData): string {
  const lines: string[] = ["Доброе утро."];

  if (data.wellbeing?.slump) {
    lines.push("", "Несколько дней подряд на низкой энергии — сегодня стоит поберечься.");
  }

  if (data.tasksToday.length > 0) {
    lines.push("", `Задачи на сегодня (${data.tasksToday.length}):`);
    for (const t of data.tasksToday) {
      lines.push(`• ${t.priority === 1 ? "! " : ""}${t.title}`);
    }
  } else {
    lines.push("", "На сегодня задач со сроком нет.");
  }

  if (data.overdue.length > 0) {
    lines.push("", `Просрочено (${data.overdue.length}):`);
    for (const t of data.overdue) lines.push(`• ${t.title}`);
  }

  if (data.reminders.length > 0) {
    lines.push("", "Напоминания:");
    for (const r of data.reminders) lines.push(`• ${r.at} — ${r.text}`);
  }

  // Обещанное клиенту — единственный раздел, который стоит выше «вчера сделано»:
  // просроченный звонок стоит денег, невыполненная задача обычно нет.
  const sales = data.sales;
  if (sales.followUps.length > 0) {
    const overdue = sales.overdueTotal > 0 ? `, просрочено ${sales.overdueTotal}` : "";
    lines.push("", `Обещано лидам (${sales.followUpsTotal}${overdue}):`);
    for (const f of sales.followUps) {
      const note = f.note ? `: ${f.note}` : "";
      lines.push(`• ${f.overdue ? "просрочено, " : ""}${f.at} — ${f.leadName}${note}`);
    }
    // Список урезан — молчать об остатке нельзя: «всё» и «первые десять»
    // требуют разных действий.
    const hidden = sales.followUpsTotal - sales.followUps.length;
    if (hidden > 0) lines.push(`• …и ещё ${hidden}`);
  }

  if (sales.stale.length > 0) {
    lines.push("", `Сделки без движения (${sales.staleTotal}):`);
    for (const d of sales.stale) {
      lines.push(`• ${d.leadName} — ${d.daysInStage} дн. на стадии «${d.stage}»`);
    }
  }

  if (data.yesterdayDone > 0) {
    lines.push("", `Вчера закрыто задач: ${data.yesterdayDone}.`);
  }

  return lines.join("\n");
}

/**
 * Формулировка брифа моделью. Числа она получает готовыми и права выдумывать
 * свои не имеет — об этом сказано в промпте прямо, потому что склонность
 * «округлить для красоты» у моделей устойчивая.
 */
async function renderBriefWithLlm(data: BriefData): Promise<{ text: string; focus?: string }> {
  const result = await llmChat({
    feature: "secretary.brief",
    preset: "smart",
    maxTokens: 700,
    messages: [
      {
        role: "system",
        content: [
          "Ты — Ася, личный секретарь владельца бизнеса. Составь короткий утренний бриф.",
          "",
          "Правила:",
          "- Русский язык, обращение на «ты», тепло и по-деловому.",
          "- 5–10 строк. Без вступлений вроде «вот ваш бриф».",
          "- Используй ТОЛЬКО факты и числа из данных ниже. Ничего не додумывай,",
          "  не округляй и не добавляй того, чего в данных нет.",
          "- Просроченные касания по лидам (sales.followUps с overdue) назови",
          "  первыми: клиент, которому обещали и не перезвонили, ждёт дольше",
          "  любой задачи из списка.",
          "- Заверши строкой «Фокус дня: …» — одно дело, которое важнее прочих.",
          "- Если владелец несколько дней на низкой энергии, предложи разгрузить",
          "  день, а не добавить в него ещё дел.",
        ].join("\n"),
      },
      { role: "user", content: JSON.stringify(data, null, 2) },
    ],
  });

  const text = result.text.trim();
  const focusLine = text.split("\n").find((l) => l.toLowerCase().startsWith("фокус дня"));
  return { text, focus: focusLine?.replace(/^фокус дня:\s*/i, "").trim() };
}

export interface BriefResult {
  created: boolean;
  sent: boolean;
  reason?: string;
}

/**
 * Собрать и отправить бриф за сегодня.
 * Идемпотентно: одна запись на дату, повторный вызов ничего не дублирует.
 */
export async function generateDailyBrief(now: Date = new Date()): Promise<BriefResult> {
  const date = briefDate(now);

  const existing = await prisma.dailyBrief.findUnique({
    where: { date },
    select: { id: true, sentToTelegramAt: true },
  });
  if (existing?.sentToTelegramAt) {
    return { created: false, sent: false, reason: "бриф за сегодня уже отправлен" };
  }

  const data = await collectBriefData(now);

  let text: string;
  let focus: string | undefined;
  try {
    const rendered = await renderBriefWithLlm(data);
    text = rendered.text;
    focus = rendered.focus;
  } catch (e) {
    // Бриф важнее красоты формулировок: без модели он всё равно должен прийти.
    const reason = e instanceof LlmUnavailableError ? e.message : String(e);
    logWarn("brief.llm_unavailable", { reason });
    text = renderBriefPlain(data);
  }

  const brief = await prisma.dailyBrief.upsert({
    where: { date },
    update: { content: text, data: data as never, focus: focus ?? null },
    create: { date, content: text, data: data as never, focus: focus ?? null },
    select: { id: true },
  });

  let sent = false;
  try {
    sent = await tgNotifyOwner(text);
    if (sent) {
      await prisma.dailyBrief.update({
        where: { id: brief.id },
        data: { sentToTelegramAt: new Date() },
      });
    }
  } catch (e) {
    logError("brief.send_failed", { error: e instanceof Error ? e.message : String(e) });
  }

  logInfo("brief.generated", {
    tasks: data.tasksToday.length,
    overdue: data.overdue.length,
    followUps: data.sales.followUpsTotal,
    sent,
  });
  return { created: true, sent };
}
