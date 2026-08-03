import { prisma } from "@/core/db";
import { logError, logInfo, logWarn } from "@/core/observability/logger";
import { tgNotifyOwner } from "@/core/telegram/bot";
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

export async function deliverDueReminders(now: Date = new Date()): Promise<{
  sent: number;
  failed: number;
}> {
  const due = await prisma.reminder.findMany({
    where: { isActive: true, nextFireAt: { lte: now } },
    orderBy: { nextFireAt: "asc" },
    take: BATCH,
    select: { id: true, text: true, nextFireAt: true, repeatPreset: true },
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
    // и не суметь отправить — значит потерять одно напоминание, о чём останется
    // запись в логе. Второе неприятно, первое непригодно для жизни.
    const rescheduled = await reschedule(reminder, tz, now);
    if (!rescheduled) {
      failed += 1;
      continue;
    }

    try {
      const ok = await tgNotifyOwner(formatReminder(reminder.text));
      if (ok) {
        sent += 1;
      } else {
        failed += 1;
        logWarn("reminder.delivery_failed", { reminderId: reminder.id });
      }
    } catch (e) {
      failed += 1;
      logError("reminder.delivery_error", {
        reminderId: reminder.id,
        error: e instanceof Error ? e.message : String(e),
      });
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
 * Сдвиг напоминания: повторяющееся — на следующий срок, разовое — в архив.
 * Возвращает false, если запись изменить не удалось (тогда не отправляем:
 * иначе получится дубль на следующей минуте).
 */
async function reschedule(
  reminder: { id: string; nextFireAt: Date; repeatPreset: string | null },
  tz: string,
  now: Date,
): Promise<boolean> {
  try {
    if (reminder.repeatPreset) {
      const next = nextFireAt(
        reminder.repeatPreset as Parameters<typeof nextFireAt>[0],
        reminder.nextFireAt,
        tz,
        now,
      );
      await prisma.reminder.update({
        where: { id: reminder.id },
        data: { nextFireAt: next, lastFiredAt: now },
      });
    } else {
      await prisma.reminder.update({
        where: { id: reminder.id },
        data: { isActive: false, lastFiredAt: now },
      });
    }
    return true;
  } catch (e) {
    logError("reminder.reschedule_failed", {
      reminderId: reminder.id,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

export function formatReminder(text: string): string {
  return `⏰ ${text}`;
}
