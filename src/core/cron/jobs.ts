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
import { shouldCheckReminders } from "@/modules/secretary/reminder-cursor";
import { hasCheckInToday } from "@/modules/secretary/checkin";
import { generateDailyBrief } from "@/modules/secretary/brief";
import { runDaySummary } from "@/modules/secretary/day-summary";
import { purgeImportArtifacts } from "@/modules/finance/import/cleanup";
import { syncYooKassa } from "@/modules/finance/yookassa/sync";
import { generateInsights } from "@/modules/finance/insights/generate";
import { tgNotifyOwner } from "@/core/telegram/bot";
import { scaleKeyboard } from "@/core/telegram/callbacks";
import type { CronJobHandler } from "@/core/cron/registry";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEDUP_TTL_DAYS = 2;

/**
 * Пульс системы: доказательство, что планировщик жив И база пишется.
 *
 * Пишет раз в сутки, а не раз в час. Часовой пульс — это 24 пробуждения
 * компьюта Neon в сутки ради одной строки в ленте, около 15 CU-часов в месяц из
 * ста общих с Agentus. При этом живость ПЛАНИРОВЩИКА и так видна в логе
 * контейнера строкой `[cron] … → 200` на каждую задачу, каждую минуту:
 * отдельная запись в базе ради того же факта — это плата за то, что уже есть.
 * Своё у пульса остаётся одно: доказательство, что база ПИШЕТСЯ, а не только
 * читается. Для этого суток достаточно.
 *
 * Сетка суточная от полуночи UTC — та же, что у шестичасового resync курсора
 * (см. reminder-cursor.ts). Совпадение намеренное: два независимых расписания
 * будили бы компьют в разные минуты и платили бы за два пробуждения вместо
 * одного, причём расход зависел бы от минуты старта контейнера.
 *
 * Отметка о последней записи живёт В ПАМЯТИ, а не проверяется запросом.
 * Запрос-проверка стоил шести пробуждений компьюта Neon в час на ровном месте
 * — при том что записать надо один раз. После рестарта отметка пуста и пульс
 * пишется сразу: это и хорошо, свежий деплой сразу отмечается в ленте.
 */
let lastHeartbeatMs = 0;

export const heartbeat: CronJobHandler = async () => {
  const now = Date.now();
  if (lastHeartbeatMs > 0 && Math.floor(now / DAY_MS) === Math.floor(lastHeartbeatMs / DAY_MS)) {
    return { ok: true, detail: "пропущено: запись уже была сегодня" };
  }

  await prisma.domainEvent.create({
    data: {
      module: "system",
      type: "heartbeat",
      title: "Планировщик и база на связи",
      payload: { gitSha: process.env.BUILD_SHA ?? "local" },
    },
  });

  // Отметка ставится ПОСЛЕ записи. Поставить до — значит на упавшей записи
  // замолчать на час ровно тогда, когда пульс и нужен: база недоступна, а
  // лента говорит, что всё в порядке.
  lastHeartbeatMs = now;

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
/**
 * Прогон, который идёт прямо сейчас.
 *
 * Планировщик контейнера стреляет `void fireCron(job)` — не дожидаясь
 * предыдущего вызова, — а пачка из десяти напоминаний под медленным Telegram
 * (три попытки по 15 с, пауза по 429 до 30 с) идёт минутами. Без этого замка
 * два прогона читают одну и ту же строку и оба её отправляют, а их сверки
 * курсора наступают друг другу на пятки.
 */
let remindersInFlight: Promise<{ sent: number; failed: number }> | null = null;

export const reminders: CronJobHandler = async () => {
  if (remindersInFlight) {
    return { ok: true, detail: "пропущено: предыдущий прогон ещё идёт" };
  }

  // Курсор в памяти отвечает на вопрос «есть ли смысл идти в базу» без похода
  // в базу. Именно это позволяет компьюту Neon засыпать: минутный запрос
  // впустую держал бы его включённым круглосуточно.
  if (!shouldCheckReminders()) {
    return { ok: true, detail: "ближайшее напоминание ещё не наступило" };
  }

  remindersInFlight = deliverDueReminders();
  let sent = 0;
  let failed = 0;
  try {
    ({ sent, failed } = await remindersInFlight);
  } finally {
    remindersInFlight = null;
  }

  if (sent === 0 && failed === 0) return { ok: true, detail: "нечего отправлять" };
  return { ok: failed === 0, detail: `отправлено: ${sent}, не удалось: ${failed}` };
};

/**
 * Вечерний чек-ин: один вопрос в день о состоянии.
 *
 * Пропускается, если чек-ин за сегодня уже есть, — владелец мог ответить
 * днём сам. Спросить дважды хуже, чем не спросить: бот, задающий один и тот
 * же вопрос, быстро начинает раздражать, а раздражающий бот перестаёт
 * получать честные ответы.
 */
export const eveningCheckin: CronJobHandler = async () => {
  if (await hasCheckInToday()) return { ok: true, detail: "чек-ин за сегодня уже есть" };

  const sent = await tgNotifyOwner("Как прошёл день? Настроение по шкале 1–5:", {
    buttons: scaleKeyboard("mood"),
  });
  return { ok: sent, detail: sent ? "вопрос отправлен" : "не удалось отправить" };
};

/**
 * Утренний бриф — 07:30 по Москве.
 *
 * Идемпотентность обеспечивает сама джоба (одна запись на дату), поэтому
 * повторный вызов после рестарта контейнера безопасен и ничего не дублирует.
 */
export const dailyBrief: CronJobHandler = async () => {
  const result = await generateDailyBrief();
  if (!result.created) return { ok: true, detail: result.reason ?? "пропущено" };
  return { ok: result.sent, detail: result.sent ? "бриф отправлен" : "составлен, но не отправлен" };
};

/**
 * Ночная сводка дня и пополнение памяти.
 *
 * Именно здесь память перестаёт зависеть от того, вспомнила ли модель вызвать
 * save_memory_fact посреди разговора: сказанное вскользь подбирается вечером.
 */
export const daySummary: CronJobHandler = async () => {
  const r = await runDaySummary();
  if (!r.summarized) return { ok: true, detail: r.reason ?? "пропущено" };
  return {
    ok: true,
    detail: `фактов добавлено: ${r.factsAdded}, дублей пропущено: ${r.factsSkipped}, векторов дозаполнено: ${r.embeddingsFilled}`,
  };
};

/**
 * Чистка следов импорта выписок.
 *
 * Сырые файлы выписок хранятся, чтобы можно было переразобрать их, если парсер
 * починили в ближайшие недели. Дольше держать банковские выписки в базе —
 * лишний риск без пользы. Срок хранения задаёт сам модуль импорта: политика
 * хранения — его зона ответственности, крон отвечает только за расписание.
 */
export const importCleanup: CronJobHandler = async () => {
  const r = await purgeImportArtifacts();
  const touched = r.purgedCommitted + r.purgedAbandoned + r.expiredPreviews;
  if (touched === 0) return { ok: true, detail: "чистить нечего" };

  logInfo("cron.imports_cleaned", { ...r });
  return {
    ok: true,
    detail: `файлов удалено: ${r.purgedCommitted + r.purgedAbandoned}, брошенных импортов закрыто: ${r.expiredPreviews}`,
  };
};

/**
 * Поступления ЮKassa — каждые 6 часов.
 *
 * Чаще незачем: деньги не пропадут, а окно синка перекрывает двое суток.
 * Реже — и владелец увидит вчерашнюю выручку сегодня вечером, то есть
 * перестанет доверять цифре на экране.
 */
export const yookassaSync: CronJobHandler = async () => {
  const r = await syncYooKassa();
  if (!r.configured) return { ok: true, detail: r.reason ?? "не настроено" };
  if (r.createdIncome === 0 && r.createdFees === 0) {
    return { ok: true, detail: `новых платежей нет (проверено ${r.fetched})` };
  }
  return {
    ok: true,
    detail: `поступлений: ${r.createdIncome}, комиссий: ${r.createdFees}, уже были: ${r.skippedExisting}`,
  };
};

/**
 * Контрольный прогон синка ЮKassa — раз в сутки, окном в 30 дней.
 *
 * Штатный прогон берёт узкое окно от прошлой синхронизации, и этого хватает,
 * пока всё идёт по плану. Контрольный нужен на случай, когда не идёт: прогоны
 * не запускались сутки, часы разъехались, поведение API изменилось. Дедуп по
 * externalId делает лишний проход бесплатным — уже записанные платежи просто
 * попадут в skippedExisting, новых строк не появится.
 *
 * Раз в сутки и ночью, потому что это страховка, а не источник свежести:
 * свежесть даёт штатный прогон четыре раза в день.
 */
export const yookassaResync: CronJobHandler = async () => {
  const r = await syncYooKassa(new Date(), { minLookbackMs: 30 * 24 * 60 * 60 * 1000 });
  if (!r.configured) return { ok: true, detail: r.reason ?? "не настроено" };
  return {
    ok: true,
    detail: `контрольные 30 дней: проверено ${r.fetched}, добрано поступлений ${r.createdIncome}, комиссий ${r.createdFees}`,
  };
};

/**
 * Финансовые наблюдения — раз в сутки, ночью.
 *
 * Чаще незачем: цифры за день меняются мало, а карточка, обновляющаяся каждый
 * час, перестаёт читаться. Дедуп по теме и периоду делает повторный прогон
 * после рестарта безопасным.
 */
export const financeInsights: CronJobHandler = async () => {
  const r = await generateInsights();
  if (r.created === 0) {
    return { ok: true, detail: r.reason ?? `новых наблюдений нет (фактов: ${r.factsFound})` };
  }
  return { ok: true, detail: `наблюдений добавлено: ${r.created}, уже были: ${r.skippedExisting}` };
};
