import type { Kitchen, LoadSnapshot } from "../types";
import { CALIBRATION } from "./calibration";

/**
 * Срез протух: считать по нему нельзя.
 *
 * Отдельная функция, а не сравнение по месту, потому что порог используется и
 * в движке, и в интерфейсе (там, где рисуется пометка «ориентировочно»).
 */
export function isStale(snapshot: LoadSnapshot, now: Date): boolean {
  const ageMin = (now.getTime() - snapshot.takenAt.getTime()) / 60_000;
  return ageMin >= CALIBRATION.stalenessMin;
}

/**
 * Сколько новый заказ простоит в очереди, прежде чем его начнут готовить.
 *
 * Кухня ведёт `parallelSlots` заказов одновременно. Если в работе меньше слотов,
 * заказ берут сразу и очередь нулевая. Если больше — заказ ждёт столько полных
 * «волн», сколько перед ним стоит.
 *
 * Волна — это не точная модель кухни, а честное приближение: заказы не
 * выпекаются строго синхронно. Но оно монотонно по загрузке и не даёт
 * ступенек в неожиданных местах, а для выбора между тремя кухнями важна
 * именно монотонность, а не абсолютная точность.
 */
export function queueMinutes(kitchen: Kitchen, ordersInProgress: number): number {
  const slots = Math.max(1, kitchen.parallelSlots);
  const ahead = Math.max(0, ordersInProgress);

  if (ahead < slots) return 0;

  const wavesAhead = Math.floor(ahead / slots);
  return wavesAhead * CALIBRATION.cookBaseMin;
}

/**
 * Сколько заказ прождёт свободного курьера, минуты.
 *
 * Курьер увозит `ordersPerCourierTrip` заказов за круг длиной
 * `courierRoundTripMin`. Значит одновременно «в обороте» может быть
 * `couriersOnShift * ordersPerCourierTrip` заказов — всё сверх этого ждёт
 * возвращения курьеров.
 *
 * Ноль курьеров — вырожденный случай: заказ не уедет никогда. Возвращаем
 * длину круга, а не бесконечность, чтобы кухня без курьеров просто оказалась
 * заведомо хуже остальных, а не сломала сравнение (Infinity ломает сортировку
 * и попадает в интерфейс как «NaN мин»).
 */
export function courierWaitMinutes(snapshot: LoadSnapshot): number {
  const capacity =
    Math.max(0, snapshot.couriersOnShift) * CALIBRATION.ordersPerCourierTrip;

  if (capacity === 0) return CALIBRATION.courierRoundTripMin;

  const waiting = Math.max(0, snapshot.ordersInDelivery);
  if (waiting < capacity) return 0;

  const tripsAhead = Math.floor(waiting / capacity);
  return tripsAhead * CALIBRATION.courierRoundTripMin;
}

/**
 * Запасная оценка загрузки по времени суток.
 *
 * Включается, когда счётчики протухли. Кривая грубая и намеренно
 * консервативная: лучше пообещать больше и привезти раньше.
 *
 * Часы — местные для Оренбурга (UTC+5). Пояс передаётся снаружи, чтобы
 * функция осталась чистой и тестируемой без подмены системного времени.
 */
export function fallbackOrdersInProgress(localHour: number): number {
  // Обеденный и вечерний пики — то, ради чего вообще нужна страховка.
  if (localHour >= 18 && localHour <= 21) return 12;
  if (localHour >= 12 && localHour <= 14) return 9;
  if (localHour >= 22 || localHour <= 2) return 6;
  return 3;
}
