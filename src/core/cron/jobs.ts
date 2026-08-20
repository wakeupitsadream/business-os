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
import { optionalEnv } from "@/core/env";
import { logInfo } from "@/core/observability/logger";
import { purgeWebhookDedup } from "@/core/telegram/dedup";
import { deliverDueReminders } from "@/modules/secretary/reminders-job";
import { backOffCursor, shouldCheckReminders } from "@/modules/secretary/reminder-cursor";
import { beginWorkPoll, completeWorkPoll, shouldPollWork } from "@/core/cron/pending-work";
import { hasCheckInToday } from "@/modules/secretary/checkin";
import { generateDailyBrief } from "@/modules/secretary/brief";
import { runDaySummary } from "@/modules/secretary/day-summary";
import { purgeImportArtifacts } from "@/modules/finance/import/cleanup";
import { syncYooKassa } from "@/modules/finance/yookassa/sync";
import { publishDuePosts } from "@/modules/sales/content/publish";
import { checkRetention } from "@/modules/sales/retention";
import { buildWeeklyReview } from "@/modules/sales/review";
import { generateInsights } from "@/modules/finance/insights/generate";
import { runParseTick } from "@/modules/sales/leadgen/runner";
import { scoreCandidates } from "@/modules/sales/leadgen/scoring";
import { generateDrafts } from "@/modules/sales/outreach/drafts";
import { tgConfigured, tgNotifyOwner, tgSendDocumentToOwner } from "@/core/telegram/bot";
import { dumpDatabase } from "@/core/backup/dump";
import { dayKey } from "@/core/shared/time";
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
  } catch (e) {
    // Неожиданный сбой пачки (сама выборка отходит внутри deliverDueReminders).
    // Без паузы следующий тик придёт через минуту — и так 1440 раз в сутки,
    // ровно тот молот, от которого уходили. Пять минут не теряют ничего.
    backOffCursor(5 * 60 * 1000);
    throw e;
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

/**
 * Тик лидогена: одна джоба за раз, по несколько страниц.
 *
 * Молчалив по умолчанию — при пустой очереди возвращает «нет прогонов» и не
 * ходит ни в какой внешний API. Крон дёргается каждые 15 минут именно потому,
 * что тик дешёвый: длинный прогон города идёт часами, и ждать его отдельной
 * командой владельцу незачем.
 */
export const parseRunner: CronJobHandler = async () => {
  // Тот же приём, что у напоминаний: без работы в базу не ходим. Прогоны
  // ставятся из этого же процесса (веб и чат), пометка мгновенная; страховка —
  // шестичасовая сверка по общей сетке, без отдельного пробуждения.
  if (!shouldPollWork("parse")) {
    return { ok: true, detail: "очередь прогонов пуста — база не тревожится" };
  }
  const token = beginWorkPoll("parse");
  try {
    const r = await runParseTick();
    completeWorkPoll("parse", token, !r.idle);
    return { ok: r.ok, detail: r.detail };
  } catch (e) {
    // Ошибка ≠ «пусто»: работа могла остаться, следующий тик проверит.
    completeWorkPoll("parse", token, true);
    throw e;
  }
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
  if (!shouldPollWork("scoring")) {
    return { ok: true, detail: "кандидатов нет — база не тревожится" };
  }
  const token = beginWorkPoll("scoring");
  try {
    const r = await scoreCandidates();
    completeWorkPoll("scoring", token, !r.idle);
    if (r.scored === 0) return { ok: true, detail: r.reason ?? "оценено: 0" };
    return { ok: true, detail: `оценено кандидатов: ${r.scored}` };
  } catch (e) {
    completeWorkPoll("scoring", token, true);
    throw e;
  }
};

/**
 * Черновики аутрича.
 *
 * Несколько раз в день по небольшой порции — суточный потолок в двадцать
 * штук набирается ровно за четыре прогона. Одним махом составить двадцать
 * можно было бы и разом, но тогда все они пришли бы утром одной стеной, а
 * разбирают их между делом.
 */
export const outreachDrafts: CronJobHandler = async () => {
  const r = await generateDrafts();
  if (r.created === 0) return { ok: true, detail: r.reason ?? "черновиков не добавлено" };
  return { ok: true, detail: `черновиков составлено: ${r.created}` };
};

/**
 * Ночная резервная копия базы — файлом в чат владельца.
 *
 * Зачем при живом PITR: PITR живёт ВНУТРИ аккаунта Neon и не переживает ни
 * потерю аккаунта, ни удаление проекта, ни исчерпание общего лимита. Файл в
 * Telegram лежит в облаке Telegram — это копия за пределами провайдера базы,
 * без новых учёток и секретов. База ~10 МБ, в сжатом виде — единицы МБ при
 * лимите бота в 50: запас на годы.
 *
 * Время 00:00 UTC выбрано не за красоту: в эту же минуту просыпаются суточный
 * пульс и шестичасовой resync курсора (обе сетки идут от полуночи UTC), так
 * что бэкап НЕ добавляет отдельного пробуждения компьюта — он едет в уже
 * оплаченном. Тест compute-budget.test.ts это закрепляет.
 *
 * Сбои не глотаются: ok:false и исключения поднимает крон-роут — он шлёт
 * владельцу тревогу с дедупом. Молчание здесь опаснее шума: копия, которой
 * молча нет, обнаруживается в самый плохой день.
 */
export const backupDb: CronJobHandler = async () => {
  if (optionalEnv("BACKUP_DELIVERY") === "off") {
    return { ok: true, detail: "выключено переменной BACKUP_DELIVERY" };
  }
  // Дампу нужна ПРЯМАЯ строка: через PgBouncer pg_dump не работает,
  // как и миграции.
  const url = optionalEnv("DIRECT_URL");
  if (!url) return { ok: false, detail: "DIRECT_URL не задан — дамп снять не с чего" };
  if (!tgConfigured()) return { ok: false, detail: "Telegram не настроен — копию некуда доставить" };

  const dump = await dumpDatabase(url);
  const name = `business-os-${dayKey(new Date())}.sql.gz`;
  const sent = await tgSendDocumentToOwner(
    name,
    dump.gz,
    "Ночная резервная копия базы. Как восстановиться — docs/OWNER-CHECKLIST.md, раздел «Резервные копии».",
  );
  if (!sent) return { ok: false, detail: "дамп собран, но не отправлен в Telegram" };

  try {
    await prisma.domainEvent.create({
      data: {
        module: "system",
        type: "backup.sent",
        title: "Резервная копия базы отправлена в Telegram",
        payload: { rawBytes: dump.rawBytes, gzBytes: dump.gzBytes },
      },
    });
  } catch {
    // Файл уже доставлен — строка в ленте не стоит ложной тревоги «упала».
  }

  const kib = (n: number) => `${Math.round(n / 1024)} КиБ`;
  return { ok: true, detail: `отправлено ${kib(dump.gzBytes)} (несжато ${kib(dump.rawBytes)})` };
};
