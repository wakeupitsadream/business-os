/**
 * Обработчики фоновых задач Фазы 0.
 *
 * Паттерн (унаследован из Agentus): крон-роут делает работу САМ, синхронно в
 * запросе — без очередей и воркеров. Один контейнер, задачи короткие; очередь
 * здесь была бы лишней движущейся частью.
 *
 * Каждый обработчик обязан быть идемпотентным: планировщик контейнера
 * дедуплицирует запуски только внутри процесса, а рестарт/передеплой в нужную
 * минуту легко даёт повторный вызов.
 */

import { prisma } from "@/core/db";
import { logInfo } from "@/core/observability/logger";
import { purgeWebhookDedup } from "@/core/telegram/dedup";
import { deliverDueReminders } from "@/modules/secretary/reminders-job";
import type { CronJobHandler } from "@/core/cron/registry";

const HOUR_MS = 60 * 60 * 1000;
const DEDUP_TTL_DAYS = 2;

/**
 * Пульс системы: доказательство, что планировщик жив И база пишется.
 *
 * Дёргается каждые 10 минут, но запись в ленту событий делает не чаще раза в
 * час: DomainEvent — это лента, которую читает владелец и из которой агент
 * берёт контекст, засорять её 144 записями в сутки нельзя.
 */
export const heartbeat: CronJobHandler = async () => {
  const since = new Date(Date.now() - HOUR_MS);

  const recent = await prisma.domainEvent.findFirst({
    where: { module: "system", type: "heartbeat", occurredAt: { gte: since } },
    select: { id: true },
  });

  if (recent) {
    return { ok: true, detail: "пропущено: запись уже была в течение часа" };
  }

  await prisma.domainEvent.create({
    data: {
      module: "system",
      type: "heartbeat",
      title: "Планировщик и база на связи",
      payload: { gitSha: process.env.BUILD_SHA ?? "local" },
    },
  });

  logInfo("cron.heartbeat_written", {});
  return { ok: true, detail: "записан DomainEvent" };
};

/**
 * Чистка журнала дедупликации вебхуков.
 *
 * WebhookDedup растёт на каждое входящее сообщение Telegram и нужен только на
 * время возможных ретраев отправителя (минуты). 48 часов — с огромным запасом;
 * без чистки таблица за год превращается в самую большую в базе на ровном месте.
 *
 * Само удаление делает подсистема Telegram: срок хранения — её зона
 * ответственности (она знает, сколько ретраит отправитель). Крон задаёт только
 * расписание. Две независимые реализации одной чистки разъезжаются при первом
 * же изменении политики хранения.
 */
export const cleanupDedup: CronJobHandler = async () => {
  const count = await purgeWebhookDedup(DEDUP_TTL_DAYS);

  logInfo("cron.dedup_cleaned", { removed: count });
  return { ok: true, detail: `удалено записей: ${count}` };
};

/**
 * Доставка сработавших напоминаний. Дёргается каждую минуту — это самая
 * частая джоба в системе, поэтому она обязана быть дешёвой: один индексный
 * запрос по (isActive, nextFireAt), и почти всегда он возвращает пусто.
 */
export const reminders: CronJobHandler = async () => {
  const { sent, failed } = await deliverDueReminders();
  if (sent === 0 && failed === 0) return { ok: true, detail: "нечего отправлять" };
  return { ok: failed === 0, detail: `отправлено: ${sent}, не удалось: ${failed}` };
};
