import { describe, it, expect } from "vitest";
import { TZDate } from "@date-fns/tz";
import { describeRepeat, nextFireAt } from "./schedule";
import { OWNER_TZ } from "@/core/shared/time";

/** Локальное время владельца → UTC-момент, чтобы тесты читались по-человечески. */
function msk(y: number, m: number, d: number, h: number, min = 0): Date {
  return new Date(new TZDate(y, m - 1, d, h, min, 0, 0, OWNER_TZ).getTime());
}

/** Обратно: как выглядит момент в часовом поясе владельца. */
function asMsk(date: Date): string {
  const t = new TZDate(date, OWNER_TZ);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
}

describe("ежедневное напоминание", () => {
  it("сохраняет время суток владельца", () => {
    const prev = msk(2026, 7, 29, 9, 0);
    const next = nextFireAt("DAILY", prev, OWNER_TZ, msk(2026, 7, 29, 9, 1));
    expect(asMsk(next)).toBe("2026-07-30 09:00");
  });

  it("догоняет до будущего, если система долго стояла", () => {
    // Контейнер не работал неделю: напоминание должно встать на ближайший
    // будущий день, а не отдать пропущенную дату.
    const prev = msk(2026, 7, 20, 9, 0);
    const next = nextFireAt("DAILY", prev, OWNER_TZ, msk(2026, 7, 27, 15, 0));
    expect(asMsk(next)).toBe("2026-07-28 09:00");
  });

  it("отсчитывает от прошлого срабатывания, а не от «сейчас»", () => {
    // Иначе доставка с опозданием сдвигала бы всю дальнейшую серию.
    const prev = msk(2026, 7, 29, 9, 0);
    const lateDelivery = msk(2026, 7, 29, 9, 47);
    expect(asMsk(nextFireAt("DAILY", prev, OWNER_TZ, lateDelivery))).toBe("2026-07-30 09:00");
  });
});

describe("напоминание по будням", () => {
  it("с пятницы переносится на понедельник", () => {
    const friday = msk(2026, 7, 31, 10, 0);
    expect(new TZDate(friday, OWNER_TZ).getDay()).toBe(5);
    const next = nextFireAt("WEEKDAYS", friday, OWNER_TZ, msk(2026, 7, 31, 10, 1));
    expect(asMsk(next)).toBe("2026-08-03 10:00");
  });

  it("в середине недели идёт на следующий день", () => {
    const wednesday = msk(2026, 7, 29, 10, 0);
    expect(new TZDate(wednesday, OWNER_TZ).getDay()).toBe(3);
    expect(asMsk(nextFireAt("WEEKDAYS", wednesday, OWNER_TZ, msk(2026, 7, 29, 11, 0)))).toBe(
      "2026-07-30 10:00",
    );
  });

  it("никогда не попадает на выходной", () => {
    let cursor = msk(2026, 7, 27, 8, 0);
    for (let i = 0; i < 15; i++) {
      cursor = nextFireAt("WEEKDAYS", cursor, OWNER_TZ, cursor);
      const weekday = new TZDate(cursor, OWNER_TZ).getDay();
      expect(weekday, `сработало в выходной: ${asMsk(cursor)}`).not.toBe(0);
      expect(weekday, `сработало в выходной: ${asMsk(cursor)}`).not.toBe(6);
    }
  });
});

describe("еженедельное напоминание", () => {
  it("тот же день недели через семь дней", () => {
    const prev = msk(2026, 7, 29, 18, 30);
    const next = nextFireAt("WEEKLY", prev, OWNER_TZ, msk(2026, 7, 29, 19, 0));
    expect(asMsk(next)).toBe("2026-08-05 18:30");
    expect(new TZDate(next, OWNER_TZ).getDay()).toBe(new TZDate(prev, OWNER_TZ).getDay());
  });
});

describe("ежемесячное напоминание", () => {
  it("сохраняет число месяца", () => {
    const prev = msk(2026, 7, 15, 12, 0);
    expect(asMsk(nextFireAt("MONTHLY", prev, OWNER_TZ, msk(2026, 7, 15, 13, 0)))).toBe(
      "2026-08-15 12:00",
    );
  });

  it("31-е число не перескакивает через короткий месяц", () => {
    // Наивное «прибавить месяц» превращает 31 января в 3 марта, и напоминание
    // «свести финансы за месяц» пропускает февраль целиком.
    const jan31 = msk(2026, 1, 31, 12, 0);
    const next = nextFireAt("MONTHLY", jan31, OWNER_TZ, msk(2026, 1, 31, 13, 0));
    expect(asMsk(next)).toBe("2026-02-28 12:00");
  });

  it("переходит через границу года", () => {
    const dec = msk(2026, 12, 10, 9, 0);
    expect(asMsk(nextFireAt("MONTHLY", dec, OWNER_TZ, msk(2026, 12, 10, 10, 0)))).toBe(
      "2027-01-10 09:00",
    );
  });
});

describe("результат всегда в будущем", () => {
  it("для любого пресета", () => {
    const now = msk(2026, 7, 29, 12, 0);
    const longAgo = msk(2025, 3, 3, 8, 0);
    for (const preset of ["DAILY", "WEEKDAYS", "WEEKLY", "MONTHLY"] as const) {
      const next = nextFireAt(preset, longAgo, OWNER_TZ, now);
      expect(next.getTime(), preset).toBeGreaterThan(now.getTime());
    }
  });
});

describe("describeRepeat", () => {
  it("описывает пресеты по-русски", () => {
    expect(describeRepeat("DAILY")).toBe("каждый день");
    expect(describeRepeat("WEEKDAYS")).toBe("по будням");
    expect(describeRepeat(null)).toBe("один раз");
  });
});

describe("длительный простой системы", () => {
  it("годовой перерыв не даёт даты в прошлом ни для одного пресета", () => {
    // Раньше здесь ограничитель цикла срабатывал раньше, чем дата догоняла
    // настоящее, и возвращалось прошедшее время: такое напоминание уходит
    // владельцу немедленно, снова пересчитывается в прошлое и превращается
    // в поток уведомлений.
    const now = msk(2026, 7, 29, 12, 0);
    const longAgo = msk(2024, 1, 3, 8, 0);
    for (const preset of ["DAILY", "WEEKDAYS", "WEEKLY", "MONTHLY"] as const) {
      const next = nextFireAt(preset, longAgo, OWNER_TZ, now);
      expect(next.getTime(), preset).toBeGreaterThan(now.getTime());
      // И не улетает далеко: следующее срабатывание должно быть близким.
      expect(next.getTime() - now.getTime(), preset).toBeLessThan(32 * 24 * 3600 * 1000);
    }
  });

  it("после перерыва сохраняется время суток и фаза серии", () => {
    const now = msk(2026, 7, 29, 12, 0);
    // Еженедельное на вторник 08:00, пропущенное за год, обязано остаться
    // вторничным и восьмичасовым.
    const tuesday = msk(2025, 7, 1, 8, 0);
    expect(new TZDate(tuesday, OWNER_TZ).getDay()).toBe(2);

    const next = nextFireAt("WEEKLY", tuesday, OWNER_TZ, now);
    expect(new TZDate(next, OWNER_TZ).getDay()).toBe(2);
    expect(asMsk(next).endsWith("08:00")).toBe(true);
  });

  it("ежемесячное после перерыва сохраняет число месяца", () => {
    const now = msk(2026, 7, 29, 12, 0);
    const next = nextFireAt("MONTHLY", msk(2024, 3, 5, 9, 30), OWNER_TZ, now);
    expect(new TZDate(next, OWNER_TZ).getDate()).toBe(5);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });
});
