import { describe, it, expect } from "vitest";
import {
  CALLBACK_DATA_LIMIT,
  buildCallbackData,
  parseCallbackData,
  reminderKeyboard,
  scaleKeyboard,
} from "./callbacks";

describe("разбор данных кнопки", () => {
  it("чек-ин: настроение и энергия", () => {
    expect(parseCallbackData("ci:mood:4")).toEqual({ kind: "checkin", field: "mood", value: 4 });
    expect(parseCallbackData("ci:energy:2")).toEqual({ kind: "checkin", field: "energy", value: 2 });
  });

  it("чек-ин: пропуск", () => {
    expect(parseCallbackData("ci:skip")).toEqual({ kind: "checkin_skip" });
  });

  it("оценка вне шкалы 1–5 не принимается", () => {
    // Значение приходит извне; шкала зашита в модели, и молча записать 9
    // означало бы получить чек-ин, который потом не с чем сравнивать.
    for (const bad of ["ci:mood:0", "ci:mood:6", "ci:mood:-1", "ci:mood:abc"]) {
      expect(parseCallbackData(bad).kind, bad).toBe("unknown");
    }
  });

  it("напоминание: готово и отложить", () => {
    expect(parseCallbackData("rem:done:abc123")).toEqual({
      kind: "reminder_done",
      reminderId: "abc123",
    });
    expect(parseCallbackData("rem:s1:abc123")).toEqual({
      kind: "reminder_snooze",
      reminderId: "abc123",
      hours: 1,
    });
    expect(parseCallbackData("rem:s24:abc123")).toEqual({
      kind: "reminder_snooze",
      reminderId: "abc123",
      hours: 24,
    });
  });

  it("задача и подтверждение действия", () => {
    expect(parseCallbackData("task:done:t1")).toEqual({ kind: "task_done", taskId: "t1" });
    expect(parseCallbackData("ap:yes:n1")).toEqual({
      kind: "approval",
      notificationId: "n1",
      approved: true,
    });
    expect(parseCallbackData("ap:no:n1")).toEqual({
      kind: "approval",
      notificationId: "n1",
      approved: false,
    });
  });

  it("мусор и пустота не роняют разбор", () => {
    for (const bad of ["", "   ", "чепуха", "rem:done", "ci", "неизвестно:действие:1"]) {
      expect(parseCallbackData(bad).kind, bad).toBe("unknown");
    }
    expect(parseCallbackData(undefined).kind).toBe("unknown");
  });
});

describe("сборка данных кнопки", () => {
  it("склеивает части через двоеточие", () => {
    expect(buildCallbackData(["rem", "done", "abc"])).toBe("rem:done:abc");
  });

  it("отказывается превышать лимит Telegram", () => {
    // Telegram отвергает всю клавиатуру целиком, и владелец получает
    // сообщение вообще без кнопок — без объяснения, что произошло.
    expect(() => buildCallbackData(["rem", "done", "x".repeat(CALLBACK_DATA_LIMIT)])).toThrow(
      /64/,
    );
  });

  it("кириллица тратит лимит быстрее — проверка считает байты, а не символы", () => {
    const cyrillic = "я".repeat(31); // 62 байта в UTF-8
    expect(() => buildCallbackData([cyrillic, "ab"])).toThrow();
  });
});

describe("клавиатуры", () => {
  it("шкала даёт пять оценок и пропуск", () => {
    const rows = scaleKeyboard("mood");
    expect(rows[0]).toHaveLength(5);
    expect(rows[1]?.[0]?.text).toBe("Пропустить");
    for (const btn of rows[0] ?? []) {
      expect(parseCallbackData(btn.callbackData).kind).toBe("checkin");
    }
  });

  it("кнопки напоминания разбираются обратно", () => {
    const rows = reminderKeyboard("r1");
    const kinds = (rows[0] ?? []).map((b) => parseCallbackData(b.callbackData).kind);
    expect(kinds).toEqual(["reminder_done", "reminder_snooze", "reminder_snooze"]);
  });

  it("длинный идентификатор ловится при сборке клавиатуры, а не в Telegram", () => {
    expect(() => reminderKeyboard("x".repeat(80))).toThrow();
  });
});
