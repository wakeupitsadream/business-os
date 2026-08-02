import { prisma } from "@/core/db";
import { logError, logInfo, logWarn } from "@/core/observability/logger";
import { tgNotifyOwner } from "@/core/telegram/bot";
import { getOwnerTimezone } from "@/core/settings";
import { nextFireAt } from "./schedule";
import { backOffCursor, beginCursorSync, setEarliestReminder } from "./reminder-cursor";

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

/** Через сколько повторить попытку после неудачной доставки. */
const RETRY_DELAY_MS = 2 * 60 * 1000;

/**
 * Сколько раз пробовать, прежде чем сдаться. Пять попыток по две минуты — это
 * десять минут: столько длится обычный блип Telegram или прокси. Дальше
 * молчание перестаёт быть техническим и становится новостью для владельца.
 */
const MAX_ATTEMPTS = 5;

/** На сколько отложить следующий поход в базу, если запрос упал. */
const DB_BACKOFF_MS = 5 * 60 * 1000;

/**
 * Текущий прогон, если он ещё идёт.
 *
 * Планировщик контейнера запускает джобу, не дожидаясь предыдущей
 * (`void fireCron(job)`), а минутный тик легко накладывается на прогон, который
 * ждёт ответа Telegram. Два одновременных прогона видят одну и ту же пачку
 * сработавших напоминаний; отправить дважды не даст атомарный захват ниже, но
 * гонять два одинаковых запроса к базе незачем — а именно от лишних походов в
 * базу зависит, заснёт ли компьют Neon. Второй вызов дожидается первого и
 * возвращает его результат.
 */
let inFlight: Promise<{ sent: number; failed: number }> | null = null;

export function deliverDueReminders(now: Date = new Date()): Promise<{
  sent: number;
  failed: number;
}> {
  if (inFlight) return inFlight;
  inFlight = runDelivery(now).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runDelivery(now: Date): Promise<{ sent: number; failed: number }> {
  let due;
  try {
    due = await prisma.reminder.findMany({
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
  } catch (e) {
    // База не ответила. Курсор при этом остаётся в состоянии «не знаю», и
    // следующий тик снова пойдёт в базу — поминутный долбёж ровно тогда, когда
    // база и так не отвечает. Отступаем на несколько минут.
    backOffCursor(DB_BACKOFF_MS, now);
    logWarn("reminder.query_failed", {
      error: e instanceof Error ? e.message : String(e),
      backOffMs: DB_BACKOFF_MS,
    });
    return { sent: 0, failed: 0 };
  }

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
    // и не суметь отправить — значит опоздать, но это подбирается повтором (см.
    // scheduleRetry). Второе неприятно, первое непригодно для жизни.
    const claimed = await claim(reminder, tz, now);
    if (!claimed) {
      // Либо запись успел забрать другой прогон, либо база отказала. И то и
      // другое означает «не наше» — отправлять нельзя.
      failed += 1;
      continue;
    }

    let delivered = false;
    try {
      delivered = await tgNotifyOwner(formatReminder(reminder.text));
    } catch (e) {
      logError("reminder.delivery_error", {
        reminderId: reminder.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    if (delivered) {
      sent += 1;
      await clearRetryState(reminder.id, reminder.deliveryAttempts);
    } else {
      failed += 1;
      logWarn("reminder.delivery_failed", { reminderId: reminder.id });
      await scheduleRetry(reminder, claimed.scheduledFor, now);
    }
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
    // должно пережить этот ответ. См. beginCursorSync в reminder-cursor.ts.
    const token = beginCursorSync();
    const next = await prisma.reminder.findFirst({
      where: { isActive: true },
      orderBy: { nextFireAt: "asc" },
      select: { nextFireAt: true },
    });
    // Токен: если пока мы ждали ответ, стартовал следующий поход, наш ответ уже
    // устарел, и применять его нельзя — он затрёт курсор прошлым.
    setEarliestReminder(next?.nextFireAt ?? null, now, token);
  } catch (e) {
    logWarn("reminder.cursor_refresh_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

interface Claimed {
  /** Время, на которое напоминание было назначено по-настоящему. */
  scheduledFor: Date;
}

/**
 * Атомарный захват напоминания вместе со сдвигом расписания.
 *
 * `updateMany` с условием на прежний `nextFireAt` — это и есть захват: если
 * запись успел изменить кто-то другой (наложившийся прогон, перенос из чата),
 * условие не совпадёт и `count` окажется нулём. Раньше здесь стоял безусловный
 * `update`, и два прогона, дошедшие сюда одновременно, оба считали захват
 * удачным — владелец получал напоминание дважды.
 *
 * Возвращает время, на которое напоминание было назначено НА САМОМ ДЕЛЕ: у
 * повторной попытки `nextFireAt` временно сдвинут, и серию надо считать от
 * исходного срока, иначе каждая неудача уводит расписание на две минуты вперёд.
 */
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
  if (attempts === 0) return;
  try {
    await prisma.reminder.updateMany({
      where: { id },
      data: { deliveryAttempts: 0 },
    });
  } catch (e) {
    // Не повод считать доставку неудачной: сообщение владелец уже получил.
    logWarn("reminder.retry_state_not_cleared", {
      reminderId: id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Не доставили — вернуть в очередь.
 *
 * Порядок «сдвинуть, потом отправить» гарантирует, что напоминание не уйдёт
 * дважды, но потерю до сих пор никто не подбирал: блип Telegram на одну минуту
 * уничтожал напоминание совсем, и владелец узнавал об этом только по тому, что
 * его не разбудили.
 *
 * `retryOf` хранит настоящий срок, чтобы серия повторяющегося напоминания не
 * уезжала: следующее срабатывание считается от него, а не от времени повтора.
 */
async function scheduleRetry(
  reminder: { id: string; text: string; deliveryAttempts: number },
  scheduledFor: Date,
  now: Date,
): Promise<void> {
  const attempts = reminder.deliveryAttempts + 1;

  if (attempts >= MAX_ATTEMPTS) {
    // Сдаёмся. Молчать нельзя: ненаступившее напоминание выглядит точно так же,
    // как ненужное, и владелец не отличит одно от другого.
    logError("reminder.delivery_gave_up", {
      reminderId: reminder.id,
      attempts,
      scheduledFor: scheduledFor.toISOString(),
    });
    await Promise.allSettled([
      prisma.reminder.updateMany({
        where: { id: reminder.id },
        data: { deliveryAttempts: 0, retryOf: null },
      }),
      // След в ленте активности: он переживёт и недоступный Telegram, и
      // перезапуск контейнера.
      prisma.domainEvent.create({
        data: {
          module: "secretary",
          type: "reminder.undelivered",
          title: `Напоминание не доставлено: ${reminder.text.slice(0, 120)}`,
          payload: { reminderId: reminder.id, attempts, scheduledFor: scheduledFor.toISOString() },
        },
      }),
    ]);
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

export function formatReminder(text: string): string {
  return `⏰ ${text}`;
}

/** Только для тестов: сбросить сериализацию прогонов. */
export function resetReminderDeliveryState(): void {
  inFlight = null;
}
