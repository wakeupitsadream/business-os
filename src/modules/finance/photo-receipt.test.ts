import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Распознавание чека с фото.
 *
 * Правило модуля: модель заполняет форму, а не пишет в деньги. Поэтому
 * главные тесты — про отбраковку: свободный текст вместо суммы, выдуманная
 * дата, «не нашла». Ошибка распознавания, попавшая в учёт молча, разойдётся
 * с банком тихо — и найдётся только сверкой руками.
 */

const chat = vi.fn(async (..._a: unknown[]) => ({ text: "{}" }) as { text: string });
vi.mock("@/core/llm", () => ({
  llmChat: (...a: unknown[]) => chat(...a),
  llmConfigured: () => true,
  LlmUnavailableError: class extends Error {},
}));

const notificationCreate = vi.fn(async (..._a: unknown[]) => ({ id: "n_photo" }));
vi.mock("@/core/db", () => ({
  prisma: { notification: { create: (...a: unknown[]) => notificationCreate(...a) } },
}));

const { extractReceipt, createReceiptApproval } = await import("./photo-receipt");

const IMAGE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

function modelSays(obj: unknown): void {
  chat.mockResolvedValue({ text: JSON.stringify(obj) });
}

beforeEach(() => {
  chat.mockReset();
  notificationCreate.mockReset();
  notificationCreate.mockResolvedValue({ id: "n_photo" });
});

describe("счастливый путь", () => {
  it("чистое число проходит, сводка называет сумму и просит подтверждения", async () => {
    modelSays({
      found: true,
      direction: "expense",
      amount: "1250.50",
      description: "бензин",
      merchant: "АЗС Лукойл",
    });

    const res = await extractReceipt(IMAGE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.args.amount).toBe("1250.50");
    expect(res.args.description).toContain("Лукойл");
    // Разряды в formatKop разделены НЕРАЗРЫВНЫМ пробелом — обычный не совпадёт.
    expect(res.summary).toContain("250,50");
    expect(res.summary).toMatch(/подтверд/i);
  });

  it("картинка уезжает в модель data-URL-ом, подпись — подсказкой", async () => {
    modelSays({ found: true, direction: "expense", amount: "100", description: "кофе" });
    await extractReceipt(IMAGE, "это за кофе");

    const call = chat.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const user = call.messages.find((m) => m.role === "user");
    const parts = user?.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts.find((p) => p.type === "image_url")?.image_url?.url).toMatch(
      /^data:image\/jpeg;base64,/,
    );
    expect(parts.find((p) => p.type === "text")?.text).toContain("за кофе");
  });

  it("ответ в ```json-заборе тоже читается", async () => {
    chat.mockResolvedValue({
      text: '```json\n{"found":true,"direction":"expense","amount":"300","description":"обед"}\n```',
    });
    const res = await extractReceipt(IMAGE);
    expect(res.ok).toBe(true);
  });
});

describe("отбраковка — то, ради чего модуль существует", () => {
  it("«1250 руб, чек №4587» НЕ проходит: первое число из мусора — не сумма", async () => {
    // parseAmountToKop взял бы 1250 и молча записал; а из «№4587 итого 1250»
    // взял бы 4587. Строгий формат отсекает обе ловушки разом.
    modelSays({ found: true, direction: "expense", amount: "1250 руб, чек №4587", description: "х" });
    const res = await extractReceipt(IMAGE);
    expect(res.ok).toBe(false);
  });

  it("честное «не нашла» модели уважается, а не дожимается", async () => {
    modelSays({ found: false, direction: "expense", amount: "", description: "-" });
    const res = await extractReceipt(IMAGE);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/не вижу/i);
  });

  it("свободный текст вместо JSON — отказ, не попытка угадать", async () => {
    chat.mockResolvedValue({ text: "На фото чек на 1250 рублей за бензин." });
    const res = await extractReceipt(IMAGE);
    expect(res.ok).toBe(false);
  });

  it("дата дальше года от сегодня отбрасывается, операция не уезжает в чужой месяц", async () => {
    modelSays({
      found: true,
      direction: "expense",
      amount: "500",
      description: "кофе",
      date: "2019-01-01",
    });
    const res = await extractReceipt(IMAGE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.args.date).toBeUndefined();
  });

  it("нулевая сумма не проходит", async () => {
    modelSays({ found: true, direction: "expense", amount: "0", description: "х" });
    const res = await extractReceipt(IMAGE);
    expect(res.ok).toBe(false);
  });
});

describe("контракт с исполнителем заявок", () => {
  it("заявка несёт ровно то, что ждёт resolveApproval: toolName + args", async () => {
    modelSays({ found: true, direction: "expense", amount: "60000", description: "аренда" });
    const res = await extractReceipt(IMAGE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    await createReceiptApproval(res);

    const data = (notificationCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.type).toBe("APPROVAL_REQUIRED");
    const payload = data.payload as { toolName: string; args: { amount: string } };
    expect(payload.toolName).toBe("add_transaction");
    expect(payload.args.amount).toBe("60000");
  });
});
