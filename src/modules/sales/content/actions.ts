import type { ContentStatus } from "@prisma/client";
import { prisma } from "@/core/db";
import { OWNER_TZ } from "@/core/shared/time";
import { TZDate } from "@date-fns/tz";

/**
 * Действия над постами.
 *
 * Правила статусов живут здесь, а не в компоненте: календарь в браузере
 * устаревает молча — крон меняет статус между рендерами, — и отказ обязан
 * приходить с сервера, а не полагаться на то, что кнопка была неактивна.
 */

export class ContentError extends Error {
  constructor(
    message: string,
    readonly code: "state" | "input" | "notfound" = "state",
  ) {
    super(message);
    this.name = "ContentError";
  }
}

/** Максимум для сообщения Telegram — пост длиннее просто не уйдёт. */
export const MAX_POST_LENGTH = 4096;

/** Статусы, которые ещё можно двигать по календарю. */
const MOVABLE: ContentStatus[] = ["IDEA", "DRAFT", "APPROVED", "SCHEDULED"];

/**
 * Перенести пост на другой день.
 *
 * Время суток сохраняется, меняется только дата: владелец тащит карточку между
 * днями, а не между часами. День приходит ключом "YYYY-MM-DD", а не готовым
 * инстантом: собранный в браузере, тот считался бы в поясе браузера, и пост,
 * назначенный на 00:30, уехал бы на соседние сутки.
 */
export async function reschedulePost(id: string, day: string, tz: string = OWNER_TZ) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new ContentError("Дата должна быть в формате ГГГГ-ММ-ДД.", "input");

  const post = await prisma.contentPost.findUnique({
    where: { id },
    select: { id: true, status: true, scheduledAt: true },
  });
  if (!post) throw new ContentError("Пост не найден.", "notfound");

  if (!MOVABLE.includes(post.status)) {
    // Крон мог опубликовать пост между рендером и перетаскиванием: карточка в
    // браузере об этом не знает.
    throw new ContentError(
      post.status === "PUBLISHED"
        ? "Пост уже опубликован — перенести его нельзя."
        : `Пост в состоянии «${post.status}» переносить нельзя.`,
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const date = Number(match[3]);

  // Час и минуту берём у прежнего времени, чтобы перенос не сбрасывал
  // «утренний» или «вечерний» слот.
  const prev = post.scheduledAt ? new TZDate(post.scheduledAt, tz) : null;
  const hour = prev?.getHours() ?? 10;
  const minute = prev?.getMinutes() ?? 0;

  const next = new TZDate(year, month, date, hour, minute, 0, 0, tz);
  const at = new Date(next.getTime());

  if (post.status === "SCHEDULED" && at.getTime() < Date.now()) {
    // Крон опубликовал бы его на ближайшем тике, и это выглядело бы как
    // «календарь сам отправил пост в канал».
    throw new ContentError(
      "Это время уже прошло. Сними пост с расписания или выбери будущий день.",
      "input",
    );
  }

  await prisma.contentPost.update({ where: { id }, data: { scheduledAt: at } });
  return at;
}

/** Сохранить правку владельца рядом с текстом модели. */
export async function editPost(id: string, body: string): Promise<void> {
  const text = body.trim();
  if (text.length === 0) throw new ContentError("Текст поста пуст.", "input");
  if (text.length > MAX_POST_LENGTH) {
    // Проверка стоит здесь, а не в джобе публикации: иначе слишком длинный
    // пост обнаружился бы в десять утра в виде невышедшего поста.
    throw new ContentError(
      `Пост длиннее ${MAX_POST_LENGTH} символов — Telegram столько не примет.`,
      "input",
    );
  }

  const updated = await prisma.contentPost.updateMany({
    where: { id, status: { in: ["IDEA", "DRAFT", "APPROVED", "SCHEDULED"] } },
    data: { editedBody: text },
  });
  if (updated.count !== 1) throw new ContentError("Пост уже опубликован или отменён.");
}

/** Одобрить: только одобренные идут в few-shot следующего плана. */
export async function approvePost(id: string): Promise<void> {
  const post = await prisma.contentPost.findUnique({
    where: { id },
    select: { body: true, editedBody: true },
  });
  if (!post) throw new ContentError("Пост не найден.", "notfound");

  const text = (post.editedBody ?? post.body ?? "").trim();
  if (text.length === 0) throw new ContentError("У поста нет текста — сначала напиши его.", "input");
  if (text.length > MAX_POST_LENGTH) {
    throw new ContentError(`Пост длиннее ${MAX_POST_LENGTH} символов.`, "input");
  }

  const updated = await prisma.contentPost.updateMany({
    where: { id, status: { in: ["IDEA", "DRAFT", "APPROVED"] } },
    data: { status: "APPROVED" },
  });
  if (updated.count !== 1) throw new ContentError("Пост уже поставлен в расписание или отменён.");
}

/** Поставить в расписание. */
export async function schedulePost(id: string, at?: Date): Promise<Date> {
  const post = await prisma.contentPost.findUnique({
    where: { id },
    select: { status: true, scheduledAt: true, body: true, editedBody: true },
  });
  if (!post) throw new ContentError("Пост не найден.", "notfound");
  if (post.status !== "APPROVED") {
    throw new ContentError("Ставить в расписание можно только одобренный пост.");
  }

  const when = at ?? post.scheduledAt;
  if (!when) throw new ContentError("Не выбрано время публикации.", "input");
  if (when.getTime() < Date.now()) {
    throw new ContentError("Это время уже прошло — выбери будущее.", "input");
  }
  if ((post.editedBody ?? post.body ?? "").trim().length === 0) {
    throw new ContentError("У поста нет текста.", "input");
  }

  const updated = await prisma.contentPost.updateMany({
    where: { id, status: "APPROVED" },
    data: { status: "SCHEDULED", scheduledAt: when, publishAttempts: 0, publishError: null },
  });
  if (updated.count !== 1) throw new ContentError("Статус поста изменился — обнови страницу.");
  return when;
}

/** Снять с расписания, пока крон его не забрал. */
export async function unschedulePost(id: string): Promise<void> {
  const updated = await prisma.contentPost.updateMany({
    where: { id, status: "SCHEDULED" },
    data: { status: "APPROVED" },
  });
  // Именно count, а не проверка до: между чтением и записью крон успевает
  // перевести пост в PUBLISHING.
  if (updated.count !== 1) throw new ContentError("Пост уже уходит в канал — снять не получится.");
}

/** Отказаться от идеи. */
export async function rejectPost(id: string): Promise<void> {
  const updated = await prisma.contentPost.updateMany({
    where: { id, status: { in: ["IDEA", "DRAFT", "APPROVED", "FAILED"] } },
    data: { status: "REJECTED" },
  });
  if (updated.count !== 1) throw new ContentError("Пост уже опубликован или публикуется.");
}
