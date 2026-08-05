import { travelMinutes } from "../geo";
import type { Coords, Eta, EtaBasis, Kitchen, LoadSnapshot } from "../types";
import { CALIBRATION } from "./calibration";
import {
  courierWaitMinutes,
  fallbackOrdersInProgress,
  isStale,
  queueMinutes,
} from "./load";

/**
 * Округление обещанного интервала.
 *
 * Наружу уходит «45–60», а не «43–58»: точность до минуты создаёт ложное
 * впечатление, будто система знает больше, чем знает.
 */
function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/**
 * Оценка времени доставки с конкретной кухни на конкретный адрес.
 *
 * Если срез протух, загрузка берётся из кривой по времени суток, а результат
 * помечается `estimate` — интерфейс покажет «ориентировочно». Курьеры в этом
 * случае считаются по штатному минимуму: сколько их на самом деле, мы не знаем,
 * а занижать до нуля значит выдать заведомо пугающее время.
 */
export function estimateEta(args: {
  kitchen: Kitchen;
  snapshot: LoadSnapshot;
  destination: Coords;
  now: Date;
  localHour: number;
}): Eta {
  const { kitchen, snapshot, destination, now, localHour } = args;

  const stale = isStale(snapshot, now);
  const basis: EtaBasis = stale ? "estimate" : "live";

  const effective: LoadSnapshot = stale
    ? {
        ...snapshot,
        ordersInProgress: fallbackOrdersInProgress(localHour),
        couriersOnShift: Math.max(1, snapshot.couriersOnShift),
        ordersInDelivery: fallbackOrdersInProgress(localHour),
      }
    : snapshot;

  const queueMin = queueMinutes(kitchen, effective.ordersInProgress);
  const cookMin = CALIBRATION.cookBaseMin;
  const courierWaitMin = courierWaitMinutes(effective);
  const travelMin = travelMinutes(kitchen.coords, destination);

  // Готовка и ожидание курьера идут ПАРАЛЛЕЛЬНО: пока заказ печётся, курьер
  // уже едет обратно. Складывать их — самая частая ошибка в таких моделях,
  // она даёт завышение на десятки минут в час пик. Заказ уезжает тогда, когда
  // выполнены оба условия, то есть по максимуму из двух.
  const readyToLeaveMin = Math.max(queueMin + cookMin, courierWaitMin);

  const rawTotal = readyToLeaveMin + travelMin + CALIBRATION.handoffMin;
  const totalMin = Math.max(CALIBRATION.promiseFloorMin, rawTotal);

  const fromMin = roundTo(
    Math.max(
      CALIBRATION.promiseFloorMin,
      totalMin - CALIBRATION.promiseLowerSlackMin,
    ),
    CALIBRATION.promiseRoundToMin,
  );
  const toMin = roundTo(
    totalMin + CALIBRATION.promiseUpperSlackMin,
    CALIBRATION.promiseRoundToMin,
  );

  return {
    totalMin: Math.round(totalMin),
    fromMin,
    // Интервал схлопнулся из-за округления — раздвигаем на один шаг.
    // «45–45» читается как обещание к минуте, которого мы не давали.
    toMin: toMin > fromMin ? toMin : fromMin + CALIBRATION.promiseRoundToMin,
    basis,
    breakdown: {
      queueMin: Math.round(queueMin),
      cookMin: Math.round(cookMin),
      courierWaitMin: Math.round(courierWaitMin),
      travelMin: Math.round(travelMin),
    },
  };
}
