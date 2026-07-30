import { describe, it, expect } from "vitest";
import { TZDate } from "@date-fns/tz";
import { checkInDate } from "./checkin";
import { OWNER_TZ } from "@/core/shared/time";

/** Дата, как её посчитал бы наивный код «по UTC». */
function naiveUtcDate(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    .toISOString()
    .slice(0, 10);
}

const asDay = (d: Date) => d.toISOString().slice(0, 10);

describe("дата чек-ина считается по времени владельца", () => {
  it("вечер — обычный случай, даты совпадают", () => {
    // 23:30 МСК = 20:30 UTC того же дня.
    expect(asDay(checkInDate(new Date("2026-07-29T20:30:00Z")))).toBe("2026-07-29");
  });

  it("после полуночи по Москве наивный расчёт по UTC отнёс бы день к прошлому", () => {
    // Ровно та дыра, ради которой функция существует: с 00:00 до 02:59 МСК
    // календарная дата в UTC ещё вчерашняя, и защита «один чек-ин в день»
    // переставала бы работать именно в те часы, когда чек-ины и делаются.
    const afterMidnightMsk = new Date("2026-07-29T21:30:00Z"); // 00:30 МСК 30 июля
    expect(asDay(checkInDate(afterMidnightMsk))).toBe("2026-07-30");
    expect(naiveUtcDate(afterMidnightMsk)).toBe("2026-07-29");
  });

  it("граница держится до 02:59 МСК", () => {
    const late = new Date("2026-07-29T23:59:00Z"); // 02:59 МСК 30 июля
    expect(asDay(checkInDate(late))).toBe("2026-07-30");
    expect(naiveUtcDate(late)).toBe("2026-07-29");
  });

  it("после 03:00 МСК расхождения больше нет", () => {
    const morning = new Date("2026-07-30T00:30:00Z"); // 03:30 МСК
    expect(asDay(checkInDate(morning))).toBe("2026-07-30");
    expect(naiveUtcDate(morning)).toBe("2026-07-30");
  });

  it("результат — полночь UTC, как требует колонка типа date", () => {
    const d = checkInDate(new Date("2026-07-29T21:30:00Z"));
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCSeconds()).toBe(0);
    expect(d.getUTCMilliseconds()).toBe(0);
  });

  it("два момента одних локальных суток дают одну дату", () => {
    // Два нажатия кнопок подряд не должны создавать две записи.
    const evening = new Date("2026-07-29T18:00:00Z"); // 21:00 МСК
    const afterMidnight = new Date("2026-07-29T22:00:00Z"); // 01:00 МСК следующего дня
    expect(asDay(checkInDate(evening))).not.toBe(asDay(checkInDate(afterMidnight)));

    const a = new Date("2026-07-29T21:10:00Z"); // 00:10 МСК 30-го
    const b = new Date("2026-07-29T21:40:00Z"); // 00:40 МСК 30-го
    expect(asDay(checkInDate(a))).toBe(asDay(checkInDate(b)));
  });

  it("уважает произвольный часовой пояс, а не только московский", () => {
    // Часовой пояс владельца хранится в настройках и однажды окажется другим.
    const moment = new Date("2026-07-29T21:30:00Z");
    expect(asDay(checkInDate(moment, "UTC"))).toBe("2026-07-29");
    expect(asDay(checkInDate(moment, OWNER_TZ))).toBe("2026-07-30");
    expect(asDay(checkInDate(moment, "Asia/Vladivostok"))).toBe("2026-07-30");
  });

  it("локальная дата совпадает с тем, что видит владелец на часах", () => {
    const moment = new Date("2026-07-29T21:30:00Z");
    const local = new TZDate(moment, OWNER_TZ);
    const expected = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
    expect(asDay(checkInDate(moment))).toBe(expected);
  });
});
