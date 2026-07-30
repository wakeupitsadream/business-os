import { describe, it, expect } from "vitest";
import { countStreak } from "./streak";

/**
 * Серия закрытых дней — маленькая цифра с большим влиянием на поведение.
 * Обнулить её ошибочно значит обесценить сам счётчик: владелец перестанет на
 * него смотреть, и вместе с ним перестанет работать вся мягкая мотивация.
 */

const DAY = 24 * 3600 * 1000;
const NOW = new Date("2026-07-29T15:00:00Z"); // 18:00 МСК
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

describe("счётчик серии", () => {
  it("без закрытых задач серии нет", () => {
    expect(countStreak([], NOW)).toBe(0);
  });

  it("считает дни подряд от сегодня", () => {
    expect(countStreak([daysAgo(0), daysAgo(1), daysAgo(2)], NOW)).toBe(3);
  });

  it("несколько задач за один день — это один день серии", () => {
    const sameDay = [NOW, new Date(NOW.getTime() - 3600e3), new Date(NOW.getTime() - 7200e3)];
    expect(countStreak(sameDay, NOW)).toBe(1);
  });

  it("пустое сегодня не рвёт серию — день ещё идёт", () => {
    // Обнулять счётчик в девять утра, когда владелец ещё ничего не успел, —
    // верный способ научить его на счётчик не смотреть.
    expect(countStreak([daysAgo(1), daysAgo(2), daysAgo(3)], NOW)).toBe(3);
  });

  it("пропущенный день серию обрывает", () => {
    expect(countStreak([daysAgo(0), daysAgo(1), daysAgo(3), daysAgo(4)], NOW)).toBe(2);
  });

  it("давняя серия без вчера и сегодня не засчитывается", () => {
    expect(countStreak([daysAgo(5), daysAgo(6)], NOW)).toBe(0);
  });

  it("порядок дат не важен", () => {
    const shuffled = [daysAgo(2), daysAgo(0), daysAgo(1)];
    expect(countStreak(shuffled, NOW)).toBe(3);
  });

  it("границы считаются по времени владельца", () => {
    // 00:30 МСК — уже новый день для владельца, хотя по UTC ещё вчера.
    const justAfterLocalMidnight = new Date("2026-07-29T21:30:00Z");
    const previousLocalDay = new Date("2026-07-29T18:00:00Z"); // 21:00 МСК 29-го
    expect(countStreak([justAfterLocalMidnight, previousLocalDay], justAfterLocalMidnight)).toBe(2);
  });
});
