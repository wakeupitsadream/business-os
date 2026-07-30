import { prisma } from "@/core/db";
import { logError, logInfo, logWarn } from "@/core/observability/logger";
import { tgApi } from "@/core/telegram/bot";
import { parseCallbackData, scaleKeyboard } from "@/core/telegram/callbacks";
import { formatLocal } from "@/core/shared/time";
import { upsertCheckIn } from "./checkin";

/**
 * Обработка нажатий inline-кнопок.
 *
 * Железное правило: на КАЖДОЕ нажатие Telegram должен получить
 * `answerCallbackQuery`. Без него кнопка в интерфейсе крутится секунд тридцать
 * и гаснет с ошибкой — владелец видит зависший бот, даже если действие
 * на самом деле выполнено.
 */

export interface CallbackContext {
  callbackId: string;
  chatId: number;
  messageId?: number;
  data?: string;
}

export async function handleCallback(ctx: CallbackContext): Promise<void> {
  const action = parseCallbackData(ctx.data);

  try {
    switch (action.kind) {
      case "checkin":
        return await onCheckIn(ctx, action.field, action.value);
      case "checkin_skip":
        return await answer(ctx, "Хорошо, пропускаем", { edit: "Чек-ин пропущен." });
      case "reminder_done":
        return await onReminderDone(ctx, action.reminderId);
      case "reminder_snooze":
        return await onReminderSnooze(ctx, action.reminderId, action.hours);
      case "task_done":
        return await onTaskDone(ctx, action.taskId);
      default:
        logWarn("telegram.callback_unknown", { data: action.kind === "unknown" ? action.raw : "" });
        return await answer(ctx, "Эта кнопка больше не активна");
    }
  } catch (e) {
    logError("telegram.callback_failed", {
      data: ctx.data,
      error: e instanceof Error ? e.message : String(e),
    });
    // Ответить Telegram нужно даже на провале — иначе кнопка зависнет.
    await answer(ctx, "Не получилось, попробуй ещё раз");
  }
}

async function onCheckIn(
  ctx: CallbackContext,
  field: "mood" | "energy",
  value: number,
): Promise<void> {
  const saved = await upsertCheckIn({ [field]: value });

  // Настроение спрашиваем первым, энергию — следом. Если энергия ещё не
  // заполнена, сразу подставляем вторую клавиатуру: два нажатия подряд
  // дешевле, чем ждать отдельного сообщения.
  if (field === "mood" && saved.energy === null) {
    await answer(ctx, `Настроение: ${value}`, {
      edit: `Настроение: ${value}/5. А энергия?`,
      keyboard: scaleKeyboard("energy"),
    });
    return;
  }

  const parts = [
    saved.mood !== null ? `настроение ${saved.mood}/5` : null,
    saved.energy !== null ? `энергия ${saved.energy}/5` : null,
  ].filter(Boolean);

  await answer(ctx, "Записала", { edit: `Чек-ин записан: ${parts.join(", ")}. Спасибо.` });
}

async function onReminderDone(ctx: CallbackContext, reminderId: string): Promise<void> {
  const reminder = await prisma.reminder.findUnique({
    where: { id: reminderId },
    select: { id: true, text: true, taskId: true },
  });
  if (!reminder) return answer(ctx, "Напоминание не найдено");

  await prisma.reminder.update({ where: { id: reminderId }, data: { isActive: false } });
  if (reminder.taskId) {
    await prisma.task.updateMany({
      where: { id: reminder.taskId, status: { in: ["TODO", "IN_PROGRESS"] } },
      data: { status: "DONE", completedAt: new Date() },
    });
  }

  await answer(ctx, "Готово", { edit: `✅ ${reminder.text}` });
}

async function onReminderSnooze(
  ctx: CallbackContext,
  reminderId: string,
  hours: number,
): Promise<void> {
  const next = new Date(Date.now() + hours * 3600 * 1000);

  const updated = await prisma.reminder.updateMany({
    where: { id: reminderId },
    // Отложенное напоминание снова становится активным: разовое к этому
    // моменту уже погашено доставкой.
    data: { nextFireAt: next, isActive: true },
  });
  if (updated.count === 0) return answer(ctx, "Напоминание не найдено");

  logInfo("reminder.snoozed", { reminderId, hours });
  await answer(ctx, hours === 1 ? "Через час" : "Завтра", {
    edit: `⏰ Отложено до ${formatLocal(next)}`,
  });
}

async function onTaskDone(ctx: CallbackContext, taskId: string): Promise<void> {
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { title: true } });
  if (!task) return answer(ctx, "Задача не найдена");

  await prisma.task.update({
    where: { id: taskId },
    data: { status: "DONE", completedAt: new Date() },
  });
  await answer(ctx, "Готово", { edit: `✅ ${task.title}` });
}

/**
 * Ответ на нажатие: всплывашка в интерфейсе + при необходимости правка текста
 * сообщения (чтобы кнопки не оставались нажимаемыми повторно).
 */
async function answer(
  ctx: CallbackContext,
  toast: string,
  opts?: { edit?: string; keyboard?: Array<Array<{ text: string; callbackData: string }>> },
): Promise<void> {
  await tgApi("answerCallbackQuery", { callback_query_id: ctx.callbackId, text: toast });

  if (!opts?.edit || ctx.messageId === undefined) return;

  await tgApi("editMessageText", {
    chat_id: ctx.chatId,
    message_id: ctx.messageId,
    text: opts.edit,
    ...(opts.keyboard
      ? {
          reply_markup: {
            inline_keyboard: opts.keyboard.map((row) =>
              row.map((b) => ({ text: b.text, callback_data: b.callbackData })),
            ),
          },
        }
      : {}),
  });
}
