import { describe, expect, it } from "vitest";
import { deepLink } from "./actions";
import { parseDraft, pickChannel } from "./drafts";

/**
 * Черновики аутрича — то, что проверяется без базы.
 *
 * Главное здесь — разбор ответа модели и ссылки. Обрывок вместо сообщения,
 * ушедший в очередь, владелец отправит не глядя; ссылка, ведущая не туда,
 * стоит одного потерянного лида.
 */

describe("разбор черновика", () => {
  it("берёт текст и основание", () => {
    const draft = parseDraft(
      JSON.stringify({
        body: "Здравствуйте! Увидел ваш сервис на Ленина — записываете по телефону? Могу показать, как это делается онлайн.",
        reasoning: "у них поток отзывов и нет записи",
      }),
    );
    expect(draft?.body).toContain("Ленина");
    expect(draft?.reasoning).toBe("у них поток отзывов и нет записи");
  });

  it("обрывок генерации черновиком не считается", () => {
    // Слишком короткое сообщение — это не «лаконично», а оборванный ответ.
    // Попав в очередь, оно будет отправлено не глядя.
    expect(parseDraft(JSON.stringify({ body: "Здравствуйте!" }))).toBeNull();
    expect(parseDraft(JSON.stringify({ body: "" }))).toBeNull();
    expect(parseDraft(JSON.stringify({ reasoning: "нет текста" }))).toBeNull();
  });

  it("мусор вместо JSON не роняет прогон", () => {
    expect(parseDraft("не могу составить сообщение")).toBeNull();
    expect(parseDraft("")).toBeNull();
  });

  it("текст вокруг JSON не мешает", () => {
    const draft = parseDraft(
      'Вот черновик:\n{"body": "Здравствуйте, увидел ваш автосервис и хотел спросить про запись клиентов."}',
    );
    expect(draft?.body).toContain("автосервис");
  });
});

describe("канал", () => {
  it("Telegram, если он известен — там переписка не выглядит рассылкой", () => {
    expect(
      pickChannel({ contacts: [{ telegram: "@master", phone: null }], phoneNormalized: null }),
    ).toBe("TELEGRAM");
  });

  it("иначе WhatsApp по номеру", () => {
    expect(pickChannel({ contacts: [], phoneNormalized: "79991234567" })).toBe("WHATSAPP");
  });

  it("звонок остаётся, когда писать некуда", () => {
    expect(pickChannel({ contacts: [], phoneNormalized: null })).toBe("PHONE");
  });
});

describe("ссылки в переписку", () => {
  it("WhatsApp получает текст сразу", () => {
    const link = deepLink("WHATSAPP", { phone: "+7 999 123-45-67" }, "Здравствуйте!");
    expect(link).toContain("https://wa.me/79991234567");
    expect(link).toContain(encodeURIComponent("Здравствуйте!"));
  });

  it("Telegram открывает диалог без текста", () => {
    // У Telegram нет способа открыть чат с заготовленным сообщением. Делать
    // вид, что подставится, значит отправить пустое вместо письма.
    const link = deepLink("TELEGRAM", { telegram: "@master" }, "Здравствуйте!");
    expect(link).toBe("https://t.me/master");
    expect(link).not.toContain("text=");
  });

  it("без контакта ссылки нет, а не ссылка в никуда", () => {
    expect(deepLink("TELEGRAM", {}, "текст")).toBeNull();
    expect(deepLink("WHATSAPP", { phone: null }, "текст")).toBeNull();
    expect(deepLink("EMAIL", { email: "" }, "текст")).toBeNull();
  });

  it("телефон чистится от разделителей", () => {
    expect(deepLink("PHONE", { phone: "8 (999) 123-45-67" }, "")).toBe("tel:+89991234567");
  });
});
