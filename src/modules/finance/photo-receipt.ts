import { z } from "zod";
import { prisma } from "@/core/db";
import { llmChat, llmConfigured } from "@/core/llm";
import { logInfo, logWarn } from "@/core/observability/logger";
import { formatKop, parseAmountToKop } from "@/core/shared/money";

/**
 * Распознавание чека или скриншота перевода с фото.
 *
 * Правило, вокруг которого построен модуль: **модель не пишет в деньги —
 * модель заполняет форму.** Распознанное проходит zod-схему, сумма — строгий
 * числовой формат, а запись происходит только после того, как владелец
 * увидел цифры и нажал «Выполнить» (та же заявка на подтверждение, что у
 * крупных расходов из чата). Ошибка распознавания, попавшая в учёт молча, —
 * худший исход: цифра выглядит правдоподобно и разойдётся с банком тихо.
 *
 * Сумма валидируется регэкспом ДО parseAmountToKop сознательно: тот берёт из
 * строки первое число, и «1250 руб, чек №4587» превратился бы в 1250 без
 * единой ошибки — а «№4587 итого 1250» в 4587. Строгий формат отсекает обе
 * ловушки: либо модель вернула голое число, либо распознавание не принимается.
 */

/** Только цифры с необязательными копейками. Никаких «руб», номеров и дат. */
const STRICT_AMOUNT = /^\d{1,7}([.,]\d{1,2})?$/;

const receiptSchema = z.object({
  found: z.boolean(),
  direction: z.enum(["expense", "income"]).default("expense"),
  amount: z.string().trim(),
  description: z.string().trim().min(1).max(120),
  /** ISO-дата с чека, если читается. Мусор отбрасывается ниже. */
  date: z.string().trim().optional(),
  merchant: z.string().trim().max(80).optional(),
});

export type ReceiptExtraction =
  | {
      ok: true;
      args: { direction: "expense" | "income"; amount: string; description: string; date?: string };
      /** Что показать владельцу над кнопками. */
      summary: string;
    }
  | { ok: false; reason: string };

const SYSTEM = [
  "Ты распознаёшь фото чека, счёта или скриншота перевода для учёта финансов.",
  "Ответь ТОЛЬКО объектом JSON без пояснений и без markdown:",
  '{"found": boolean, "direction": "expense"|"income", "amount": "число", "description": "за что", "date": "ГГГГ-ММ-ДД", "merchant": "продавец"}',
  "Правила:",
  "— amount: ИТОГОВАЯ сумма ГОЛЫМ числом, например \"1250\" или \"1250.50\". Без валюты, без пробелов, без номера чека.",
  "— Если на фото несколько сумм — бери итог к оплате.",
  "— direction: expense для покупки и оплаты, income для входящего перевода.",
  "— description: коротко и по-русски, что куплено или за что платёж.",
  "— date: только если она видна на фото; не выдумывай.",
  "— Если это не чек и не платёж, или сумма не читается уверенно: {\"found\": false, ...} — честное «не нашла» лучше выдуманной цифры.",
].join("\n");

export async function extractReceipt(
  image: Uint8Array,
  caption?: string,
): Promise<ReceiptExtraction> {
  if (!llmConfigured()) {
    return { ok: false, reason: "ИИ-шлюзы не настроены — фото разобрать нечем." };
  }

  const dataUrl = `data:image/jpeg;base64,${Buffer.from(image).toString("base64")}`;
  const hint = caption ? `Подпись владельца к фото: «${caption}».` : "Подписи к фото нет.";

  const result = await llmChat({
    feature: "finance.photo_receipt",
    // smart, а не cheap: это деньги, и цена ошибки распознавания выше цены
    // запроса. Обе модели smart-роли (Polza и ProxyAPI) понимают картинки.
    preset: "smart",
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: [
          { type: "text", text: hint },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  });

  const parsed = parseModelJson(result.text);
  if (!parsed) {
    logWarn("photo_receipt.bad_json", { sample: result.text.slice(0, 120) });
    return { ok: false, reason: "Не смогла уверенно прочитать фото. Напишите сумму текстом — запишу." };
  }
  if (!parsed.found) {
    return { ok: false, reason: "Не вижу на фото чека или платежа. Если он там есть — снимите крупнее или напишите сумму текстом." };
  }

  const amount = parsed.amount.replace(/\s/g, "");
  if (!STRICT_AMOUNT.test(amount)) {
    // Модель вернула не голое число — не гадаем, что она имела в виду.
    logWarn("photo_receipt.amount_rejected", { amount: parsed.amount.slice(0, 40) });
    return { ok: false, reason: "Сумму на фото не разобрать однозначно. Напишите её текстом — запишу." };
  }
  const kop = parseAmountToKop(amount);
  if (kop === null || kop <= 0) {
    return { ok: false, reason: "Сумма на фото не разобралась. Напишите её текстом — запишу." };
  }

  const date = normalizeDate(parsed.date);
  const description = [parsed.merchant, parsed.description]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" — ")
    .slice(0, 120);

  const summary = [
    `🧾 На фото ${parsed.direction === "expense" ? "расход" : "поступление"}: ${formatKop(kop)}`,
    `${description}${date ? ` · ${date}` : ""}`,
    "",
    "Записать? Пока не подтвердите — в учёт не попадёт.",
  ].join("\n");

  logInfo("photo_receipt.extracted", { kop, direction: parsed.direction, hasDate: Boolean(date) });
  return {
    ok: true,
    args: {
      direction: parsed.direction,
      amount,
      description,
      ...(date ? { date } : {}),
    },
    summary,
  };
}

/** JSON из ответа модели: терпим обёртку в ```-заборы, но не свободный текст. */
function parseModelJson(text: string): z.infer<typeof receiptSchema> | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    const check = receiptSchema.safeParse(JSON.parse(stripped));
    return check.success ? check.data : null;
  } catch {
    return null;
  }
}

/**
 * Дата с чека принимается только разумная: ISO-формат и не дальше года от
 * сегодня в обе стороны. Иначе опечатка распознавания уводит операцию в
 * чужой месяц — молча, как раз туда, где её никто не ищет.
 */
function normalizeDate(raw: string | undefined): string | undefined {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const parsed = new Date(`${raw}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  const yearMs = 365 * 24 * 3600 * 1000;
  if (Math.abs(parsed.getTime() - Date.now()) > yearMs) return undefined;
  return raw;
}

/**
 * Заявка на запись распознанного — тот же механизм, что у крупных расходов
 * из чата (см. modules/secretary/approvals): кнопки «Выполнить»/«Отклонить»,
 * идемпотентность, повторная проверка схемы перед исполнением. Фото не
 * заводит собственный путь записи — он был бы вторым мнением о том, что
 * такое операция.
 */
export async function createReceiptApproval(
  extraction: Extract<ReceiptExtraction, { ok: true }>,
): Promise<{ notificationId: string }> {
  const notification = await prisma.notification.create({
    data: {
      type: "APPROVAL_REQUIRED",
      module: "finance",
      title: "Подтвердите запись с фото",
      body: extraction.summary,
      // Контракт исполнителя заявок: toolName + args, actionId необязателен.
      payload: { toolName: "add_transaction", args: extraction.args } as never,
    },
    select: { id: true },
  });
  return { notificationId: notification.id };
}
