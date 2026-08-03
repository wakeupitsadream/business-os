import { prisma } from "@/core/db";
import { logError, logInfo, logWarn } from "@/core/observability/logger";
import { tgNotifyOwner, tgPublishToChannel, contentChannelId } from "@/core/telegram/bot";
import { formatLocal } from "@/core/shared/time";

/**
 * Автопостинг в канал.
 *
 * Публикация — единственное действие в системе, которое видят посторонние, и
 * единственное, которое нельзя отменить кодом. Поэтому здесь всё построено
 * вокруг одного вопроса: что делать, когда мы НЕ ЗНАЕМ, ушёл пост или нет.
 *
 * Ответ: ничего. Пост уходит в UNCERTAIN, владельцу приходит сообщение, и
 * дальше решает он, посмотрев канал. Автоматический повтор в этом месте — это
 * второй пост на глазах у подписчиков, который придётся удалять руками.
 */

/** Пост, просроченный больше чем на столько, сам не публикуется. */
const STALE_MS = 2 * 60 * 60 * 1000;

/** Столько ждём подтверждения от захваченного поста, прежде чем счесть исход неизвестным. */
const PUBLISHING_TIMEOUT_MS = 10 * 60 * 1000;

/** Больше этого числа неудач — перестаём пытаться и говорим владельцу. */
const MAX_ATTEMPTS = 3;

/** Сколько постов берём за один тик: канал не лента, пачками туда не пишут. */
const BATCH = 3;

export interface PublishResult {
  published: number;
  failed: number;
  uncertain: number;
  skipped: number;
}

/**
 * Разобрать посты, застрявшие в PUBLISHING.
 *
 * Переиспользовать протухший замок, как это делает лидоген со своими джобами,
 * здесь НЕЛЬЗЯ. Там повтор страницы стоит квоты API, здесь — контейнер мог
 * умереть уже ПОСЛЕ того, как Telegram принял сообщение. Единственный честный
 * исход застрявшего поста — «не знаем».
 */
async function sweepStuck(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - PUBLISHING_TIMEOUT_MS);

  const stuck = await prisma.contentPost.findMany({
    where: { status: "PUBLISHING", publishingAt: { lt: cutoff } },
    select: { id: true, title: true },
    take: 20,
  });
  if (stuck.length === 0) return 0;

  for (const post of stuck) {
    await prisma.contentPost.updateMany({
      where: { id: post.id, status: "PUBLISHING" },
      data: {
        status: "UNCERTAIN",
        publishError: "Прогон оборвался во время публикации — исход неизвестен",
        publishingAt: null,
      },
    });
    logError("content.publish_stuck", { postId: post.id });
  }

  await notifyUncertain(stuck.map((p) => p.title));
  return stuck.length;
}

/**
 * Сказать владельцу о постах с неизвестным исходом.
 *
 * Об успехах не пишем: бот, который отчитывается по любому поводу, перестают
 * читать, а успех и так виден в канале и в ленте событий.
 */
async function notifyUncertain(titles: string[]): Promise<void> {
  if (titles.length === 0) return;
  const list = titles.slice(0, 5).map((t) => `• ${t}`).join("\n");
  const more = titles.length > 5 ? `\n…и ещё ${titles.length - 5}` : "";
  await tgNotifyOwner(
    [
      "Не знаю, ушли ли эти посты в канал:",
      "",
      list + more,
      "",
      "Загляни в канал. Если поста там нет — верни его в расписание в разделе «Контент»; если есть — отметь опубликованным. Сам я повторять не буду: это был бы второй пост у всех на виду.",
    ].join("\n"),
  ).catch(() => undefined);
}

/** Один тик автопостинга. */
export async function publishDuePosts(now: Date = new Date()): Promise<PublishResult> {
  const result: PublishResult = { published: 0, failed: 0, uncertain: 0, skipped: 0 };

  result.uncertain += await sweepStuck(now);

  if (!contentChannelId()) {
    // Ненастроенный канал — не поломка: владелец мог ещё не завести бота
    // админом. Молчим, как молчит синк ЮKassa без ключей.
    return result;
  }

  const due = await prisma.contentPost.findMany({
    where: {
      status: "SCHEDULED",
      channel: "TELEGRAM",
      scheduledAt: { lte: now },
    },
    orderBy: { scheduledAt: "asc" },
    take: BATCH,
    select: {
      id: true,
      title: true,
      body: true,
      editedBody: true,
      scheduledAt: true,
      publishAttempts: true,
    },
  });

  for (const post of due) {
    // Пост, просроченный на пару часов, сам в канал не идёт. После суточного
    // простоя первый же тик иначе вывалил бы туда вчерашнюю пачку — а
    // вчерашний пост в четыре утра хуже, чем невышедший.
    const lateBy = post.scheduledAt ? now.getTime() - post.scheduledAt.getTime() : 0;
    if (lateBy > STALE_MS) {
      await prisma.contentPost.updateMany({
        where: { id: post.id, status: "SCHEDULED" },
        data: {
          status: "UNCERTAIN",
          publishError: `Время публикации прошло ${Math.round(lateBy / 3600_000)} ч назад`,
        },
      });
      result.skipped += 1;
      logWarn("content.publish_too_late", { postId: post.id, lateByMs: lateBy });
      continue;
    }

    const text = (post.editedBody ?? post.body ?? "").trim();
    if (text.length === 0) {
      await prisma.contentPost.updateMany({
        where: { id: post.id, status: "SCHEDULED" },
        data: { status: "FAILED", publishError: "У поста нет текста" },
      });
      result.failed += 1;
      continue;
    }

    // Захват. Счётчик попыток растёт ЗДЕСЬ, до отправки: если прогон умрёт
    // посреди неё, следующий увидит увеличенный счётчик, а не ноль.
    const claimed = await prisma.contentPost.updateMany({
      where: { id: post.id, status: "SCHEDULED" },
      data: {
        status: "PUBLISHING",
        publishingAt: now,
        publishAttempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) {
      // Пост успел взять другой прогон: планировщик стреляет следующий, не
      // дожидаясь предыдущего.
      result.skipped += 1;
      continue;
    }

    const outcome = await tgPublishToChannel(text);

    if (outcome.kind === "published") {
      await prisma.contentPost.updateMany({
        where: { id: post.id, status: "PUBLISHING" },
        data: {
          status: "PUBLISHED",
          publishedAt: now,
          publishingAt: null,
          externalId: String(outcome.messageId),
          publishError: null,
        },
      });
      await prisma.domainEvent.create({
        data: {
          module: "sales",
          type: "content.published",
          title: `Пост опубликован: ${post.title.slice(0, 120)}`,
          payload: { postId: post.id, messageId: outcome.messageId },
        },
      });
      result.published += 1;
      continue;
    }

    if (outcome.kind === "uncertain") {
      // Не знаем — и не узнаем сами. Дальше решает владелец.
      await prisma.contentPost.updateMany({
        where: { id: post.id, status: "PUBLISHING" },
        data: { status: "UNCERTAIN", publishingAt: null, publishError: outcome.reason },
      });
      result.uncertain += 1;
      logError("content.publish_uncertain", { postId: post.id, reason: outcome.reason });
      await notifyUncertain([post.title]);
      continue;
    }

    // Отказ осмысленный: сообщения в канале точно нет. Такое чинится
    // настройкой (бот не админ канала, канал переименован), а не повтором,
    // поэтому попытки быстро заканчиваются.
    const attempts = post.publishAttempts + 1;
    const giveUp = attempts >= MAX_ATTEMPTS;
    await prisma.contentPost.updateMany({
      where: { id: post.id, status: "PUBLISHING" },
      data: {
        status: giveUp ? "FAILED" : "SCHEDULED",
        publishingAt: null,
        publishError: outcome.reason,
      },
    });
    result.failed += 1;
    logWarn("content.publish_rejected", { postId: post.id, attempts, reason: outcome.reason });

    if (giveUp) {
      await tgNotifyOwner(
        `Пост «${post.title.slice(0, 120)}» опубликовать не удалось: ${outcome.reason}. Дальше не пробую — посмотри настройки канала.`,
      ).catch(() => undefined);
    }
  }

  if (result.published + result.failed + result.uncertain > 0) {
    logInfo("content.publish_tick", { ...result });
  }
  return result;
}

/** Решение владельца по посту с неизвестным исходом. */
export async function resolveUncertain(
  postId: string,
  decision: "published" | "reschedule",
  now: Date = new Date(),
): Promise<boolean> {
  const data =
    decision === "published"
      ? {
          status: "PUBLISHED" as const,
          publishedAt: now,
          publishError: null,
          publishAttempts: 0,
        }
      : {
          // Возвращаем в расписание, но время владелец назначает заново:
          // молча ставить прошедшее время значило бы опубликовать на
          // ближайшем тике, а он этого не просил.
          status: "APPROVED" as const,
          scheduledAt: null,
          publishError: null,
          publishAttempts: 0,
        };

  const updated = await prisma.contentPost.updateMany({
    where: { id: postId, status: "UNCERTAIN" },
    data,
  });
  return updated.count === 1;
}

/** Текст для ленты: когда пост уйдёт в канал. */
export function describeSchedule(at: Date | null): string {
  return at ? formatLocal(at) : "время не назначено";
}
