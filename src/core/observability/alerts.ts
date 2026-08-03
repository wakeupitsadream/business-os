import { prisma } from "@/core/db";
import { logError, logWarn } from "./logger";
import { tgNotifyOwner } from "@/core/telegram/bot";

/**
 * Тревоги владельцу.
 *
 * Система, которая пишет о каждой ошибке, читается ровно один раз. Дальше
 * сообщения от неё пролистывают, и настоящая авария теряется среди шума — тот
 * же урок, что с ботом, отчитывающимся о каждом успешном действии.
 *
 * Поэтому здесь три ограничителя, и все три обязательны:
 *   1. дедуп по виду — одна и та же поломка шлёт одно сообщение за окно, а не
 *      по сообщению на каждое повторение;
 *   2. потолок в час — даже разные поломки не должны превращаться в поток;
 *   3. запрет рекурсии — тревога об упавшем Telegram не отправляется через
 *      Telegram.
 */

/** Сколько молчим про ту же поломку после первого сообщения. */
const DEDUP_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Сколько тревог в час допустимо суммарно. */
const HOURLY_CAP = 4;

/**
 * Вид тревоги. Список закрытый: тревога — это то, на что владелец МОЖЕТ
 * повлиять, а свободная строка неизбежно превращается в свалку всего подряд.
 */
export type AlertKind =
  /** Фоновая задача упала. */
  | "cron_failed"
  /** Все шлюзы моделей недоступны — система молчит вместо ответов. */
  | "llm_down"
  /** База не отвечает джобам. */
  | "db_down"
  /** Дневной бюджет на модели исчерпан: дорогие роли отказывают. */
  | "budget_exhausted";

const TITLE: Record<AlertKind, string> = {
  cron_failed: "Фоновая задача падает",
  llm_down: "Модели недоступны",
  db_down: "База не отвечает",
  budget_exhausted: "Дневной лимит на модели исчерпан",
};

/**
 * Идёт ли отправка тревоги прямо сейчас.
 *
 * Защита от рекурсии: `tgNotifyOwner` внутри себя пишет в лог, а вызывающий
 * код может обернуть неудачу отправки в новую тревогу — и система начнёт
 * бесконечно пытаться сообщить о том, что не может сообщать.
 */
let sending = false;

export interface AlertResult {
  sent: boolean;
  reason?: "duplicate" | "capped" | "recursion" | "send_failed";
}

/**
 * Сообщить владельцу о поломке.
 *
 * Дедуп и потолок держатся в `DomainEvent`, а не в памяти процесса: контейнер
 * перезапускается на каждом деплое, и тревога, отправленная до перезапуска,
 * ушла бы повторно — ровно в тот момент, когда владелец и так разбирается с
 * инцидентом.
 */
export async function alertOwner(
  kind: AlertKind,
  detail: string,
  now: Date = new Date(),
): Promise<AlertResult> {
  if (sending) return { sent: false, reason: "recursion" };

  try {
    const since = new Date(now.getTime() - DEDUP_WINDOW_MS);
    const sameKind = await prisma.domainEvent.findFirst({
      where: {
        module: "system",
        type: "alert.sent",
        occurredAt: { gte: since },
        payload: { path: ["kind"], equals: kind },
      },
      select: { id: true },
    });
    if (sameKind) {
      logWarn("alert.suppressed_duplicate", { kind });
      return { sent: false, reason: "duplicate" };
    }

    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const recent = await prisma.domainEvent.count({
      where: { module: "system", type: "alert.sent", occurredAt: { gte: hourAgo } },
    });
    if (recent >= HOURLY_CAP) {
      // Поток разных тревог — сам по себе признак того, что сломалось что-то
      // общее. Гнать его владельцу в мессенджер бессмысленно.
      logError("alert.capped", { kind, recent });
      return { sent: false, reason: "capped" };
    }

    sending = true;
    let ok = false;
    try {
      ok = await tgNotifyOwner(
        [`⚠️ ${TITLE[kind]}`, "", detail, "", "Подробности — в логах приложения."].join("\n"),
      );
    } finally {
      sending = false;
    }

    if (!ok) {
      logError("alert.send_failed", { kind });
      return { sent: false, reason: "send_failed" };
    }

    // Отметка пишется ПОСЛЕ успешной отправки: упав между шагами, мы повторим
    // тревогу — это лучше, чем замолчать о ней навсегда.
    await prisma.domainEvent.create({
      data: {
        module: "system",
        type: "alert.sent",
        title: TITLE[kind],
        payload: { kind, detail: detail.slice(0, 500) },
        occurredAt: now,
      },
    });

    return { sent: true };
  } catch (e) {
    // Тревога, уронившая вызывающий код, хуже несостоявшейся тревоги: она
    // ломает как раз ту джобу, которая пыталась пожаловаться.
    logError("alert.failed", { kind, error: e instanceof Error ? e.message : String(e) });
    return { sent: false, reason: "send_failed" };
  }
}
