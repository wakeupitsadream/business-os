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
import { runParseTick } from "@/modules/sales/leadgen/runner";
import { scoreCandidates } from "@/modules/sales/leadgen/scoring";
import { tgNotifyOwner } from "@/core/telegram/bot";
import { scaleKeyboard } from "@/core/telegram/callbacks";
import type { CronJobHandler } from "@/core/cron/registry";

const HOUR_MS = 60 * 60 * 1000;
const DEDUP_TTL_DAYS = 2;

/**
 * Пульс системы: доказательство, что планировщик жив И база пишется.
 *
 * Пишет не чаще раза в час: DomainEvent — лента, которую читает владелец и из
 * которой агент берёт контекст, засорять её сотней записей в сутки нельзя.
 *
 * Отметка о последней записи живёт В ПАМЯТИ, а не проверяется запросом.
 * Запрос-проверка стоил шести пробуждений компьюта Neon в час на ровном месте
 * — при том что записать надо один раз. После рестарта отметка пуста и пульс
 * пишется сразу: это и хорошо, свежий деплой сразу отмечается в ленте.
 */
let lastHeartbeatMs = 0;

export const heartbeat: CronJobHandler = async () => {
  const now = Date.now();
  if (now - lastHeartbeatMs < HOUR_MS) {
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

/**
 * Тик лидогена: одна джоба за раз, по несколько страниц.
 *
 * Молчалив по умолчанию — при пустой очереди возвращает «нет прогонов» и не
 * ходит ни в какой внешний API. Крон дёргается каждые 15 минут именно потому,
 * что тик дешёвый: длинный прогон города идёт часами, и ждать его отдельной
 * командой владельцу незачем.
 */
export const parseRunner: CronJobHandler = async () => {
  const r = await runParseTick();
  return { ok: r.ok, detail: r.detail };
};

/**
 * Скоринг собранных кандидатов.
 *
 * Отдельной задачей, а не внутри `parse-runner`: поход в модель и на чужие
 * сайты занимает секунды, а тик сбора должен оставаться дешёвым. Порция
 * маленькая — дневной бюджет на модель один на всю систему, и лидоген не
 * вправе выесть его целиком.
 */
export const candidateScoring: CronJobHandler = async () => {
  const r = await scoreCandidates();
  if (r.scored === 0) return { ok: true, detail: r.reason ?? "оценено: 0" };
  return { ok: true, detail: `оценено кандидатов: ${r.scored}` };
};
