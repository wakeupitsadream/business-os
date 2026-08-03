import { prisma } from "@/core/db";
import { LlmUnavailableError, llmChat } from "@/core/llm";
import { logInfo, logWarn } from "@/core/observability/logger";
import { tgNotifyOwner } from "@/core/telegram/bot";
import { createDeal, createLead } from "./leads";
import { formatPhone, normalizePhone } from "./phone";

/**
 * Входящая заявка с agentus.space.
 *
 * Единственный путь, которым в систему попадают данные СНАРУЖИ по инициативе
 * чужого сервиса. Отсюда три требования, каждое из которых уже стоило крови в
 * других местах системы.
 *
 * **Сначала записать, потом всё остальное.** Заявка — это деньги; черновик
 * ответа, пуш в Telegram и обращение к модели к ней не относятся. Порядок
 * обратный («сформулировать и отправить, потом сохранить») означал бы, что
 * недоступная модель или лежащий Telegram теряют лида навсегда, причём молча:
 * человек заполнил форму и ждёт.
 *
 * **Модель не должна уметь заблокировать приём.** Черновик первого ответа —
 * приятная мелочь, а не часть заявки. Он делается после записи, с коротким
 * потолком по времени, и его провал не меняет ответ Agentus.
 *
 * **Повтор не создаёт второго лида.** Agentus вправе ретраить: сеть моргнула,
 * ответ потерялся. Дедуп двухуровневый — по `externalId` заявки, если он есть,
 * и по телефону (уникальный индекс `Lead.phoneNormalized`).
 */

export interface InboundLeadInput {
  /** Идентификатор заявки на стороне Agentus — ключ идемпотентности. */
  externalId?: string | null;
  name: string;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  site?: string | null;
  /** Что человек написал в форме. */
  message?: string | null;
}

export interface InboundLeadResult {
  leadId: string;
  dealId: string | null;
  /** true — заявку уже принимали, второй раз ничего не создано. */
  duplicate: boolean;
}

/** Потолок на черновик ответа. Дольше — заявка важнее вежливости. */
const DRAFT_TIMEOUT_MS = 12_000;

export async function acceptInboundLead(input: InboundLeadInput): Promise<InboundLeadResult> {
  const name = input.name.trim() || "Заявка без имени";
  const externalId = input.externalId?.trim() || null;

  // Ключ идемпотентности проверяем ПЕРВЫМ: он точнее телефона (в форме могли
  // ошибиться) и дешевле.
  if (externalId) {
    const seen = await prisma.touchPoint.findUnique({
      where: { inboundExternalId: externalId },
      select: { leadId: true, dealId: true },
    });
    if (seen) {
      logInfo("sales.inbound_duplicate", { externalId, leadId: seen.leadId });
      return { leadId: seen.leadId, dealId: seen.dealId, duplicate: true };
    }
  }

  const { leadId, merged } = await createLead({
    name,
    phone: input.phone,
    city: input.city,
    site: input.site,
    source: "INBOUND_SITE",
    note: input.message?.trim() || null,
    contact: {
      name,
      phone: input.phone,
      email: input.email,
      // Заявку с сайта оставляет человек: минимальный состав данных и
      // авто-очистка по 152-ФЗ, если он так и не сконвертируется.
      isPersonalData: true,
    },
  });

  // Сделка заводится сразу: заявка с сайта — это уже интерес, и попадать она
  // должна в воронку, а не в список лидов, откуда её надо ещё достать.
  const { dealId } = await createDeal({ leadId });

  await prisma.touchPoint.create({
    data: {
      leadId,
      dealId,
      kind: "NOTE",
      body: input.message?.trim() || "Заявка с сайта без сообщения",
      inboundExternalId: externalId,
      meta: {
        channel: "inbound_site",
        ...(input.email ? { email: input.email } : {}),
      },
    },
  });

  logInfo("sales.inbound_accepted", { leadId, dealId, merged, externalId: externalId ?? undefined });

  // Дальше — то, что не должно влиять на приём заявки.
  await notifyOwner({ leadId, name, phone: input.phone, city: input.city, message: input.message });

  return { leadId, dealId, duplicate: false };
}

/**
 * Пуш владельцу с черновиком первого ответа.
 *
 * Всё внутри — best effort. Ошибка здесь не должна ни бросаться наружу, ни
 * менять ответ Agentus: заявка уже в базе, а уведомление можно и пережить.
 */
async function notifyOwner(lead: {
  leadId: string;
  name: string;
  phone?: string | null;
  city?: string | null;
  message?: string | null;
}): Promise<void> {
  try {
    const draft = await draftFirstReply(lead);
    const phone = formatPhone(normalizePhone(lead.phone));

    const lines = [
      "🔔 Заявка с сайта",
      `${lead.name}${lead.city ? `, ${lead.city}` : ""}`,
      phone ? `Телефон: ${phone}` : "Телефон не указан",
      lead.message?.trim() ? `\n«${lead.message.trim()}»` : "",
      draft ? `\n\nЧерновик ответа:\n${draft}` : "",
    ].filter(Boolean);

    await tgNotifyOwner(lines.join("\n"));
  } catch (e) {
    logWarn("sales.inbound_notify_failed", {
      leadId: lead.leadId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Черновик первого ответа.
 *
 * Возвращает `null` при любой проблеме — ненастроенные шлюзы, исчерпанный
 * дневной бюджет, таймаут. Пуш без черновика полезен, пуш с извинением вместо
 * черновика — нет.
 *
 * Отправляет ЧЕРНОВИК, а не сообщение: система принципиально не пишет клиентам
 * сама. Владелец копирует, правит и отправляет руками.
 */
async function draftFirstReply(lead: {
  name: string;
  city?: string | null;
  message?: string | null;
}): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DRAFT_TIMEOUT_MS);

  try {
    const res = await llmChat({
      feature: "sales.inbound_draft",
      // Дешёвый пресет: это две вежливые фразы, а не рассуждение.
      preset: "cheap",
      temperature: 0.4,
      maxTokens: 220,
      signal: controller.signal,
      messages: [
        {
          role: "system",
          content: [
            "Ты помогаешь владельцу SaaS Agentus отвечать на заявки с сайта.",
            "Напиши короткий первый ответ от первого лица: 2–3 предложения.",
            "По-русски, на «вы», без канцелярита и без восклицательных знаков.",
            "Цель ответа — договориться о коротком созвоне или демонстрации.",
            "Не выдумывай фактов о клиенте и не обещай сроков и цен.",
            "Верни только текст сообщения, без пояснений и без кавычек.",
          ].join(" "),
        },
        {
          role: "user",
          content: [
            `Имя или компания: ${lead.name}`,
            lead.city ? `Город: ${lead.city}` : null,
            lead.message?.trim() ? `Сообщение из формы: ${lead.message.trim()}` : "Сообщения нет.",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    });

    return res.text.trim() || null;
  } catch (e) {
    if (!(e instanceof LlmUnavailableError)) {
      logWarn("sales.inbound_draft_failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
