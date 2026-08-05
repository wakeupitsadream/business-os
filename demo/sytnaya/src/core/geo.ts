import { CALIBRATION } from "./dispatch/calibration";
import type { Coords } from "./types";

const EARTH_RADIUS_KM = 6371;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Расстояние по большому кругу, километры.
 *
 * Это «по прямой», реальный пробег длиннее — поправку даёт `detourFactor`
 * в `travelMinutes`. Разделено намеренно: расстояние — факт, поправка —
 * калибруемая величина.
 */
export function haversineKm(a: Coords, b: Coords): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Время в пути от кухни до адреса, минуты.
 *
 * Без учёта ожидания курьера — только дорога. Ожидание считает `courierWait`:
 * это разные величины, и смешивать их нельзя, иначе при росте очереди время
 * начинает расти «из-за расстояния», что бессмысленно для владельца.
 */
export function travelMinutes(from: Coords, to: Coords): number {
  const roadKm = haversineKm(from, to) * CALIBRATION.detourFactor;
  return (roadKm / CALIBRATION.citySpeedKmh) * 60;
}
