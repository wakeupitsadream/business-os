import { prisma } from "@/core/db";
import { logError, logInfo, logWarn } from "@/core/observability/logger";
import { tgNotifyOwnerDetailed, type TgSendOutcome } from "@/core/telegram/bot";
import { getOwnerTimezone } from "@/core/settings";
import { nextFireAt } from "./schedule";
import { beginCursorSync, setEarliestReminder } from "./reminder-cursor";

/**
 * Доставка сработавших напоминаний.
 *
 * Дёргается каждую минуту. Главное требование — не разбудить владельца
 * дважды одним и тем же: любой сбой обязан оставлять напоминание либо
 * доставленным ровно один раз, либо неотправленным, но не «отправленным и
 * всё ещё висящим в очереди».
 */

/**
 * За раз обрабатываем ограниченную пачку. Если за время простоя накопилось
 * сорок напоминаний, вываливать их разом бессмысленно: Telegram ограничивает
 * частоту, а владелец получит стену сообщений. Остаток уйдёт на следующей минуте.
 */
const BATCH = 10;

/** Через сколько повторить недоставленное. */
const RETRY_DELAY_MS = 2 * 60 * 1000;

/** Сколько раз пробуем, прежде чем сдаться и сказать об этом вслух. */
const MAX_ATTEMPTS = 5;

export async function deliverDueReminders(now: Date = new Date()): Promise<{
  sent: number;
  failed: number;
}> {
  const due = await prisma.reminder.findMany({
    where: { isActive: true, nextFireAt: { lte: now } },
    orderBy: { nextFireAt: "asc" },
    take: BATCH,
    select: {
      id: true,
      text: true,
      nextFireAt: true,
      repeatPreset: true,
      deliveryAttempts: true,
      retryOf: true,
    },
  });

  if (due.length === 0) {
    await refreshCursor(now);
    return { sent: 0, failed: 0 };
  }

  const tz = await getOwnerTimezone();
  let sent = 0;
  let failed = 0;

  for (const reminder of due) {
    // Сначала сдвигаем расписание, потом отправляем.
    //
    // Порядок именно такой из-за того, что дороже ошибиться. Отправить и упасть
    // до сдвига — значит на следующей минуте отправить снова, и так до конца
    // времён: владелец получает одно и то же напоминание раз в минуту. Сдвинуть
    // и не суметь отправить — значит опоздать, но это подбирается повтором
    // (см. scheduleRetry). Второе неприятно, первое непригодно для жизни.
    const claimed = await claim(reminder, tz, now);
    if (!claimed) {
      // Либо строку успел забрать другой прогон (при деплое два контейнера
      // какое-то время живут разом), либо база отказала. И то и другое значит
      // «не наше» — отправлять нельзя.
      failed += 1;
      continue;
    }

    let outcome: TgSendOutcome;
    try {
      outcome = await tgNotifyOwnerDetailed(formatReminder(reminder.text));
    } catch (e) {
      outcome = { ok: false, reason: "failed" };
      logError("reminder.delivery_error", {
        reminderId: reminder.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    if (outcome.ok) {
      sent += 1;
      await clearRetryState(reminder.id, reminder.deliveryAttempts);
      continue;
    }

    failed += 1;
    logWarn("reminder.delivery_failed", { reminderId: reminder.id, reason: outcome.reason });
    await scheduleRetry(reminder, claimed.scheduledFor, now, outcome.reason);
  }

  await refreshCursor(now);

  logInfo("reminder.batch_done", { due: due.length, sent, failed });
  return { sent, failed };
}

/**
 * Обновление курсора ближайшего срабатывания.
 *
 * Делается ПОСЛЕ обработки пачки и только на тех тиках, где мы всё равно
 * ходили в базу, — то есть бесплатно относительно пробуждений компьюта.
 *
 * Сбой этого запроса намеренно не роняет доставку: напоминания уже отправлены,
 * а невыставленный курсор просто заставит следующий тик сходить в базу.
 */
async function refreshCursor(now: Date): Promise<void> {
  try {
    // Строго до запроса: всё, что запишут другие задачи, пока мы ждём ответ,
    // должно пережить этот ответ. Номер нужен, чтобы отличить свой ответ от
    // устаревшего, если за это время начался другой поход в базу.
    const token = beginCursorSync();
    const next = await prisma.reminder.findFirst({
      where: { isActive: true },
      orderBy: { nextFireAt: "asc" },
      select: { nextFireAt: true },
    });
    setEarliestReminder(next?.nextFireAt ?? null, now, token);
  } catch (e) {
    logWarn("reminder.cursor_refresh_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Забрать напоминание себе и сдвинуть расписание.
 *
 * Условие `nextFireAt: <прежнее значение>` делает это захватом, а не просто
 * записью: при деплое новый контейнер поднимается, пока старый ещё жив, и оба
 * видят одну строку. Обновится она ровно у одного — второй получит count 0 и
 * не отправит ничего. Защита только в памяти процесса тут не работает: память
 * у контейнеров разная.
 *
 * Следующий срок считается от `retryOf`, если сейчас идёт повтор: иначе серия
 * повторяющегося напоминания уезжала бы на две минуты при каждой неудаче.
 */
interface Claimed {
  scheduledFor: Date;
}

async function claim(
  reminder: {
    id: string;
    nextFireAt: Date;
    repeatPreset: string | null;
    retryOf: Date | null;
  },
  tz: string,
  now: Date,
): Promise<Claimed | null> {
  const scheduledFor = reminder.retryOf ?? reminder.nextFireAt;

  try {
    const data = reminder.repeatPreset
      ? {
          nextFireAt: nextFireAt(
            reminder.repeatPreset as Parameters<typeof nextFireAt>[0],
            scheduledFor,
            tz,
            now,
          ),
          lastFiredAt: now,
          retryOf: null,
        }
      : { isActive: false, lastFiredAt: now, retryOf: null };

    const updated = await prisma.reminder.updateMany({
      where: { id: reminder.id, isActive: true, nextFireAt: reminder.nextFireAt },
      data,
    });
    return updated.count === 1 ? { scheduledFor } : null;
  } catch (e) {
    logError("reminder.reschedule_failed", {
      reminderId: reminder.id,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** Успешная доставка обнуляет счётчик попыток. */
async function clearRetryState(id: string, attempts: number): Promise<void> {
  // Ноль, undefined или NaN — обнулять нечего, лишний запрос не нужен.
  if (!attempts) return;
  try {
    await prisma.reminder.updateMany({ where: { id }, data: { deliveryAttempts: 0 } });
  } catch (e) {
    // Не повод считать доставку неудачной: сообщение владелец уже получил.
    logWarn("reminder.retry_state_not_cleared", {
      reminderId: id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Не доставили — вернуть в очередь. Кроме одного случая.
 *
 * **Таймаут не повторяется.** При нём запрос скорее всего ДОШЁЛ, потерян
 * только ответ, и повтор означает второй будильник владельцу — возможно,
 * среди ночи. Это инвариант всей отправки в этом репозитории, и напоминания
 * не исключение. Но и молчать нельзя: раз мы не знаем, дошло ли, об этом
 * должна остаться запись в ленте.
 */
async function scheduleRetry(
  reminder: { id: string; text: string; deliveryAttempts: number },
  scheduledFor: Date,
  now: Date,
  reason: TgSendOutcome["reason"],
): Promise<void> {
  if (reason === "timeout") {
    logWarn("reminder.delivery_uncertain", { reminderId: reminder.id });
    await noteUndelivered(reminder, scheduledFor, "uncertain", reminder.deliveryAttempts);
    return;
  }

  const attempts = reminder.deliveryAttempts + 1;

  if (attempts >= MAX_ATTEMPTS) {
    // Сдаёмся. Молчать нельзя: ненаступившее напоминание выглядит точно так же,
    // как ненужное, и владелец не отличит одно от другого.
    logError("reminder.delivery_gave_up", {
      reminderId: reminder.id,
      attempts,
      scheduledFor: scheduledFor.toISOString(),
    });
    await noteUndelivered(reminder, scheduledFor, "gave-up", attempts);
    return;
  }

  try {
    await prisma.reminder.updateMany({
      where: { id: reminder.id },
      data: {
        isActive: true,
        nextFireAt: new Date(now.getTime() + RETRY_DELAY_MS),
        retryOf: scheduledFor,
        deliveryAttempts: attempts,
      },
    });
    logWarn("reminder.delivery_retry", { reminderId: reminder.id, attempts });
  } catch (e) {
    logError("reminder.retry_schedule_failed", {
      reminderId: reminder.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * След в ленте активности: он переживёт и недоступный Telegram, и перезапуск
 * контейнера. Лог для этого не годится — владелец его не читает.
 */
async function noteUndelivered(
  reminder: { id: string; text: string },
  scheduledFor: Date,
  kind: "gave-up" | "uncertain",
  attempts: number,
): Promise<void> {
  const title =
    kind === "uncertain"
      ? `Напоминание могло не дойти: ${reminder.text.slice(0, 120)}`
      : `Напоминание не доставлено: ${reminder.text.slice(0, 120)}`;

  await Promise.allSettled([
    prisma.reminder.updateMany({
      where: { id: reminder.id },
      data: { deliveryAttempts: 0, retryOf: null },
    }),
    prisma.domainEvent.create({
      data: {
        module: "secretary",
        type: "reminder.undelivered",
        title,
        payload: { reminderId: reminder.id, attempts, kind, scheduledFor: scheduledFor.toISOString() },
      },
    }),
  ]);
}

export function formatReminder(text: string): string {
  return `⏰ ${text}`;
}
