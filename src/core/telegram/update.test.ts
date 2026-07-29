import { describe, expect, it } from "vitest";
import {
  parseTelegramUpdate,
  unsupportedReply,
  updateChatId,
  type TelegramUpdate,
} from "./update";

const chat = { id: 777 };

describe("parseTelegramUpdate", () => {
  it("разбирает обычный текст и обрезает пробелы", () => {
    const parsed = parseTelegramUpdate({ update_id: 1, message: { chat, text: "  привет  " } });
    expect(parsed).toEqual({ kind: "text", chatId: 777, text: "привет" });
  });

  it("берёт caption, когда текста нет (фото с подписью)", () => {
    const parsed = parseTelegramUpdate({
      update_id: 2,
      message: { chat, photo: [{ file_id: "x" }], caption: "счёт за март" },
    });
    expect(parsed).toEqual({ kind: "text", chatId: 777, text: "счёт за март" });
  });

  it("превращает контакт в текст с номером", () => {
    const parsed = parseTelegramUpdate({
      update_id: 3,
      message: { chat, contact: { phone_number: "+79001234567", first_name: "Максим" } },
    });
    expect(parsed).toEqual({ kind: "text", chatId: 777, text: "Мой номер телефона: +79001234567" });
  });

  it("обрезает слишком длинный входящий текст", () => {
    const parsed = parseTelegramUpdate({ update_id: 4, message: { chat, text: "я".repeat(9000) } });
    expect(parsed.kind).toBe("text");
    if (parsed.kind !== "text") throw new Error("ожидался текст");
    expect(parsed.text.length).toBe(4000);
  });

  it("распознаёт голосовое как неподдержанное", () => {
    const parsed = parseTelegramUpdate({
      update_id: 5,
      message: { chat, voice: { file_id: "v", duration: 3 } },
    });
    expect(parsed).toEqual({ kind: "unsupported", chatId: 777, media: "voice" });
  });

  it.each([
    ["photo", { photo: [{ file_id: "p" }] }, "photo"],
    ["document", { document: { file_id: "d" } }, "document"],
    ["sticker", { sticker: { file_id: "s" } }, "sticker"],
    ["video_note", { video_note: { file_id: "vn" } }, "video"],
    ["location", { location: { latitude: 55, longitude: 37 } }, "location"],
  ])("распознаёт %s без подписи", (_name, payload, media) => {
    const parsed = parseTelegramUpdate({ update_id: 6, message: { chat, ...payload } });
    expect(parsed).toEqual({ kind: "unsupported", chatId: 777, media });
  });

  it("игнорирует служебный апдейт без содержимого", () => {
    const parsed = parseTelegramUpdate({ update_id: 7, message: { chat } });
    expect(parsed).toEqual({ kind: "ignored", reason: "service_message" });
  });

  it("игнорирует сообщение без чата", () => {
    const parsed = parseTelegramUpdate({ update_id: 8, message: { text: "привет" } });
    expect(parsed).toEqual({ kind: "ignored", reason: "no_chat" });
  });

  it("игнорирует апдейт без сообщения", () => {
    expect(parseTelegramUpdate({ update_id: 9 })).toEqual({ kind: "ignored", reason: "no_message" });
  });

  it("игнорирует нажатие кнопки и правку сообщения (Фаза 0)", () => {
    expect(parseTelegramUpdate({ update_id: 10, callback_query: { id: "c", data: "done" } })).toEqual({
      kind: "ignored",
      reason: "callback_query",
    });
    expect(parseTelegramUpdate({ update_id: 11, edited_message: { chat, text: "правка" } })).toEqual({
      kind: "ignored",
      reason: "edited_message",
    });
  });

  it("не падает на пустом объекте", () => {
    expect(parseTelegramUpdate({} as TelegramUpdate).kind).toBe("ignored");
  });
});

describe("updateChatId", () => {
  it("достаёт chat_id из сообщения и из нажатия кнопки", () => {
    expect(updateChatId({ message: { chat, text: "x" } })).toBe(777);
    expect(updateChatId({ callback_query: { id: "c", message: { chat } } })).toBe(777);
    expect(updateChatId({ update_id: 1 })).toBeNull();
  });
});

describe("unsupportedReply", () => {
  it("для голосового обещает распознавание речи", () => {
    expect(unsupportedReply("voice")).toContain("распознавание речи");
  });

  it("любой ответ просит написать текстом", () => {
    for (const media of ["voice", "photo", "document", "video", "sticker", "location", "other"] as const) {
      expect(unsupportedReply(media)).toContain("текстом");
    }
  });
});
