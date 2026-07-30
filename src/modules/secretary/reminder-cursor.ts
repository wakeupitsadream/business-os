/**
 * Курсор ближайшего напоминания — в памяти процесса.
 *
 * Зачем. Крон напоминаний ходит в базу каждую минуту, и почти всегда впустую:
 * напоминаний нет, ответ пустой. На обычной базе это ничего не стоит. На Neon
 * стоит: запрос раз в минуту не даёт компьюту простоять пять минут без
 * нагрузки, тот не засыпает никогда и выбирает месячный лимит компьют-часов
 * за две с половиной недели. Лимит общий на аккаунт, и вместе с Business OS
 * остановится всё остальное, что живёт на том же Neon.
 *
 * Как. Держим в памяти время ближайшего срабатывания и ходим в базу только
 * когда оно наступило. Это законно ровно потому, что контейнер один и все
 * записи напоминаний идут через него же: и разговор с Асей, и кнопки Telegram
 * обслуживает этот процесс.
 *
 * Главный инвариант: **курсор обязан быть НЕ ПОЗЖЕ настоящего ближайшего
 * срабатывания.** Ошибка в раннюю сторону стоит одного лишнего запроса,
 * ошибка в позднюю — непришедшего напоминания. Поэтому всякая запись только
 * двигает курсор раньше (`noteReminderDue`), а отмены и переносы на потом
 * игнорируются: они делают курсор пессимистичнее, что безопасно.
 *
 * На случай, если новый путь записи однажды забудут подключить, курсор раз в
 * час всё равно перечитывается из базы. Тогда цена забывчивости — задержка
 * максимум на час, а не потерянное навсегда напоминание.
 */

import { logInfo } from "@/core/observability/logger";

/** Как часто курсор перечитывается из базы независимо от его значения. */
const RESYNC_MS = 60 * 60 * 1000;

/**
 * null — «не знаем, надо спросить базу» (старт процесса).
 * Infinity — «активных напоминаний нет».
 */
let earliestMs: number | null = null;
let lastSyncMs = 0;

/** Идти ли в базу за напоминаниями на этом тике. */
export function shouldCheckReminders(now: Date = new Date()): boolean {
  if (earliestMs === null) return true;
  if (now.getTime() - lastSyncMs >= RESYNC_MS) return true;
  return now.getTime() >= earliestMs;
}

/**
 * База ответила: ближайшее активное напоминание — вот это (или их нет).
 * Вызывается после каждого похода в базу.
 */
export function setEarliestReminder(next: Date | null, now: Date = new Date()): void {
  earliestMs = next === null ? Number.POSITIVE_INFINITY : next.getTime();
  lastSyncMs = now.getTime();
}

/**
 * Появилось или подвинулось напоминание. Курсор берёт минимум — проспать
 * новое напоминание нельзя, а лишний раз проснуться можно.
 *
 * Если курсор ещё не знает состояния базы (null), трогать его не надо:
 * ближайший тик и так сходит в базу.
 */
export function noteReminderDue(at: Date): void {
  if (earliestMs === null) return;
  const ms = at.getTime();
  if (ms < earliestMs) earliestMs = ms;
}

/**
 * Сбросить курсор в «не знаю». Нужен там, где состояние базы могло измениться
 * непредсказуемо и дешевле перечитать, чем рассуждать.
 */
export function invalidateReminderCursor(): void {
  earliestMs = null;
}

/** Диагностика: что курсор думает прямо сейчас. */
export function reminderCursorState(): { earliest: Date | null; knows: boolean } {
  if (earliestMs === null) return { earliest: null, knows: false };
  if (!Number.isFinite(earliestMs)) return { earliest: null, knows: true };
  return { earliest: new Date(earliestMs), knows: true };
}

/** Только для тестов. */
export function resetReminderCursor(): void {
  earliestMs = null;
  lastSyncMs = 0;
}

export function logCursor(event: string): void {
  const state = reminderCursorState();
  logInfo(event, {
    knows: state.knows,
    earliest: state.earliest?.toISOString() ?? "нет активных",
  });
}
