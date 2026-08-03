import { prisma } from "@/core/db";
import { logWarn } from "@/core/observability/logger";
import { ConnectorError, type ConnectorId, type ConnectorLimits } from "./types";

/**
 * Троттлинг обращений к внешним API лидогена.
 *
 * Два независимых ограничения, и они намеренно устроены по-разному.
 *
 * **Частота (в минуту) — в памяти.** Защищает от 429 источника. Окно короткое,
 * перезапуск контейнера в худшем случае даёт один лишний всплеск на минуту —
 * цена, за которую не стоит ходить в базу на каждый запрос.
 *
 * **Суточный кап — в базе.** Здесь ровно наоборот, и память не годится
 * категорически: контейнер перезапускается на КАЖДОМ деплое, счётчик
 * обнуляется, и три деплоя за день пробивают кап втрое. Молча — потому что
 * узнать об этом можно только по пустой выдаче в середине месяца, когда
 * бесплатный тир кончился.
 *
 * Расход считается за ПОПЫТКУ, а не за успех. Провайдер списывает квоту и за
 * запрос, вернувший ошибку; считать только удачные значит систематически
 * недосчитывать ровно в те дни, когда что-то не так.
 */

/** Метки времени запросов в текущем минутном окне, по коннекторам. */
const minuteHits = new Map<ConnectorId, number[]>();
const MINUTE_MS = 60_000;

/** Календарный день UTC — см. комментарий к модели `ConnectorQuota`. */
export function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface QuotaDecision {
  allowed: boolean;
  reason?: "minute" | "daily";
  /** Сколько ждать до следующей попытки, секунды. */
  retryAfterSec: number;
  /** Сколько запросов осталось в суточном капе после этого. */
  dailyRemaining: number;
}

/**
 * Забронировать один запрос к источнику.
 *
 * Бронь, а не проверка: суточный счётчик увеличивается ЗДЕСЬ, до обращения к
 * API. Проверить и увеличить потом — значит оставить окно, в которое два
 * параллельных вызова оба увидят «место есть» и оба его займут.
 */
export async function reserveRequest(
  connector: ConnectorId,
  limits: ConnectorLimits,
  now: Date = new Date(),
): Promise<QuotaDecision> {
  const perMinute = checkMinute(connector, limits, now.getTime());
  if (!perMinute.allowed) return perMinute;

  const day = utcDayKey(now);

  /**
   * Две попытки, и вторая — не перестраховка.
   *
   * Ноль обновлённых строк означает одно из двух: записи на сегодня ещё нет
   * либо кап уже выбран. Различаем попыткой создать — но если создать не
   * вышло из-за уникального индекса, это значит лишь, что строку создал
   * параллельный вызов, а вовсе не что место кончилось. Первая версия делала
   * здесь именно такой вывод, и на пустой таблице двадцать одновременных
   * запросов получали ОДНО разрешение вместо пяти: девятнадцать спотыкались о
   * конфликт создания и объявляли исчерпанным кап, в котором было место.
   * Поймано тестом на параллельные запросы.
   *
   * После конфликта строка заведомо существует, поэтому второго круга хватает.
   */
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Атомарный инкремент под условием «ещё не упёрлись». Условие внутри
    // UPDATE, а не отдельным SELECT: между чтением и записью помещается второй
    // вызов, и оба занимают последнее место в капе.
    const bumped = await prisma.connectorQuota.updateMany({
      where: { connector, day, used: { lt: limits.dailyCap } },
      data: { used: { increment: 1 } },
    });

    if (bumped.count === 1) {
      const row = await prisma.connectorQuota.findUnique({
        where: { connector_day: { connector, day } },
        select: { used: true },
      });
      return {
        allowed: true,
        retryAfterSec: 0,
        dailyRemaining: Math.max(0, limits.dailyCap - (row?.used ?? limits.dailyCap)),
      };
    }

    if (attempt > 0) break;

    try {
      await prisma.connectorQuota.create({ data: { connector, day, used: 1 } });
      return { allowed: true, retryAfterSec: 0, dailyRemaining: limits.dailyCap - 1 };
    } catch {
      // Строку создал кто-то параллельно — идём на второй круг инкремента.
    }
  }

  logWarn("sales.connector_daily_cap", { connector, day, cap: limits.dailyCap });
  return {
    allowed: false,
    reason: "daily",
    retryAfterSec: secondsUntilUtcMidnight(now),
    dailyRemaining: 0,
  };
}

function checkMinute(
  connector: ConnectorId,
  limits: ConnectorLimits,
  nowMs: number,
): QuotaDecision {
  const cutoff = nowMs - MINUTE_MS;
  const kept = (minuteHits.get(connector) ?? []).filter((t) => t > cutoff);

  if (kept.length >= limits.requestsPerMinute) {
    minuteHits.set(connector, kept);
    const oldest = kept[0] ?? nowMs;
    return {
      allowed: false,
      reason: "minute",
      retryAfterSec: Math.max(1, Math.ceil((oldest + MINUTE_MS - nowMs) / 1000)),
      dailyRemaining: 0,
    };
  }

  kept.push(nowMs);
  minuteHits.set(connector, kept);
  return { allowed: true, retryAfterSec: 0, dailyRemaining: 0 };
}

function secondsUntilUtcMidnight(now: Date): number {
  const midnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
}

/** Сколько запросов израсходовано сегодня — для экрана лидогена. */
export async function usedToday(connector: ConnectorId, now: Date = new Date()): Promise<number> {
  const row = await prisma.connectorQuota.findUnique({
    where: { connector_day: { connector, day: utcDayKey(now) } },
    select: { used: true },
  });
  return row?.used ?? 0;
}

/** Бросить, если запрос делать нельзя. Обёртка для коннекторов. */
export async function assertCanRequest(
  connector: ConnectorId,
  limits: ConnectorLimits,
  now: Date = new Date(),
): Promise<void> {
  const decision = await reserveRequest(connector, limits, now);
  if (decision.allowed) return;

  throw new ConnectorError(
    decision.reason === "daily"
      ? `Суточный лимит источника исчерпан (${limits.dailyCap}). Продолжим завтра.`
      : `Слишком часто обращаемся к источнику, подождите ${decision.retryAfterSec} с.`,
    "quota",
  );
}

/** Только для тестов: сбросить минутное окно в памяти. */
export function resetMinuteWindow(): void {
  minuteHits.clear();
}
