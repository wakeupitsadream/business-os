import { prisma } from "@/core/db";
import { logInfo, logWarn } from "@/core/observability/logger";
import { OWNER_TZ, formatLocal, periodKey } from "@/core/shared/time";
import { formatKop } from "@/core/shared/money";
import { YOOKASSA_ACCOUNT_ID } from "@/modules/finance/yookassa/sync";
import { yooConfigured } from "@/modules/finance/yookassa/client";
import { scheduleFollowUp } from "./leads";
import { TZDate } from "@date-fns/tz";

/**
 * Удержание: сигнал «платёж не пришёл».
 *
 * Главное свойство этого модуля — он молчит. Ложная тревога здесь дороже
 * пропущенной: владелец, которого система дёргает зря, перестаёт ей верить, и
 * тогда не сработает и настоящий сигнал. Поэтому тревога поднимается только
 * когда сошлось всё сразу, а любое сомнение трактуется в пользу молчания.
 */

/** Сколько ждём сверх ожидаемой даты, прежде чем считать платёж пропущенным. */
const GRACE_DAYS = 5;

/**
 * Насколько свежим должен быть синк, чтобы ему верить.
 *
 * Самая важная страховка модуля. Протухший ключ ЮKassa, блокировка исходящего
 * HTTP или суточный простой хостинга дают ноль платежей у ВСЕХ клиентов разом.
 * Без этой проверки система за один прогон завела бы по задаче на каждого —
 * худший возможный сценарий для доверия.
 */
const SYNC_FRESH_MS = 12 * 60 * 60 * 1000;

/**
 * Сколько тревог за прогон считается сигналом о клиентах, а не об интеграции.
 *
 * Одновременная тишина у трёх и более клиентов почти никогда не значит три
 * одновременных ухода. Вместо трёх персональных задач заводится одна: «проверь
 * синк». Дешёвая страховка от того, что один плохой месяц сожжёт доверие.
 */
const MASS_ALARM_LIMIT = 3;

/** Сколько платежей нужно, чтобы у клиента появилось предсказуемое расписание. */
const MIN_PAYMENTS = 2;

export interface RetentionResult {
  checked: number;
  alarms: number;
  skippedStaleSync: boolean;
  massAlarm: boolean;
}

/**
 * Ожидаемая дата следующего платежа: якорный день месяца с зажимом.
 *
 * Не «последний платёж плюс 30 дней»: 31 января плюс 30 — это 2 марта, потом
 * 1 апреля, и за год окно уезжает на неделю, начиная бить тревогу на ровном
 * месте. Якорь по последнему платежу не лучше: одно опоздание на четыре дня
 * сдвигает расписание навсегда, и каждый следующий цикл считается по неверному
 * окну. Первый платёж — единственная дата, которая не двигается.
 */
export function expectedNextPaymentAt(
  anchorDay: number,
  after: Date,
  tz: string = OWNER_TZ,
): Date {
  const local = new TZDate(after, tz);
  const year = local.getFullYear();
  const month = local.getMonth() + 1;

  // День 0 следующего месяца — последнее число нужного: так 31-е в феврале
  // зажимается до 28-го, а не переносится на март.
  const daysInMonth = new TZDate(year, month + 1, 0, 12, 0, 0, 0, tz).getDate();
  const day = Math.min(anchorDay, daysInMonth);

  return new Date(new TZDate(year, month, day, 12, 0, 0, 0, tz).getTime());
}

/** Свеж ли синк настолько, чтобы верить отсутствию платежей. */
async function syncIsFresh(now: Date): Promise<boolean> {
  if (!yooConfigured()) return false;
  const account = await prisma.account.findUnique({
    where: { id: YOOKASSA_ACCOUNT_ID },
    select: { lastSyncedAt: true },
  });
  const last = account?.lastSyncedAt;
  return Boolean(last && now.getTime() - last.getTime() <= SYNC_FRESH_MS);
}

/**
 * Пересчитать факты о клиенте из операций.
 *
 * Джоба — сверщик, а не событие по таймеру: каждый прогон заново читает
 * платежи и только потом решает. Поэтому платёж, пришедший на четвёртый день,
 * просто двигает ожидание на следующий месяц, и тревога не срабатывает вовсе.
 */
async function recompute(customer: {
  id: string;
  subscriptionId: string | null;
}): Promise<{
  paymentsCount: number;
  firstPaymentAt: Date | null;
  lastPaymentAt: Date | null;
  mrrKop: number;
  anchorDay: number | null;
  expectedNextAt: Date | null;
} | null> {
  if (!customer.subscriptionId) return null;

  const payments = await prisma.transaction.findMany({
    where: {
      subscriptionId: customer.subscriptionId,
      // Только доход: комиссия эквайринга — вторая строка того же платежа.
      type: "INCOME",
      source: "YOOKASSA",
    },
    orderBy: { date: "asc" },
    select: { date: true, amountKop: true },
  });

  if (payments.length === 0) {
    return {
      paymentsCount: 0,
      firstPaymentAt: null,
      lastPaymentAt: null,
      mrrKop: 0,
      anchorDay: null,
      expectedNextAt: null,
    };
  }

  const first = payments[0]!;
  const last = payments[payments.length - 1]!;
  const anchorDay = new TZDate(first.date, OWNER_TZ).getDate();

  return {
    paymentsCount: payments.length,
    firstPaymentAt: first.date,
    lastPaymentAt: last.date,
    mrrKop: last.amountKop,
    anchorDay,
    expectedNextAt: expectedNextPaymentAt(anchorDay, last.date),
  };
}

/** Один прогон проверки удержания. */
export async function checkRetention(now: Date = new Date()): Promise<RetentionResult> {
  const result: RetentionResult = {
    checked: 0,
    alarms: 0,
    skippedStaleSync: false,
    massAlarm: false,
  };

  if (!(await syncIsFresh(now))) {
    // Не проверяли — и не притворяемся, что проверили.
    result.skippedStaleSync = true;
    logWarn("retention.sync_stale", { reason: "синк ЮKassa устарел или не настроен" });
    return result;
  }

  const customers = await prisma.customer.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, leadId: true, dealId: true, subscriptionId: true, missedSignalKey: true },
  });

  const candidates: Array<{
    id: string;
    leadId: string;
    dealId: string | null;
    expectedNextAt: Date;
    lastPaymentAt: Date;
    mrrKop: number;
    cycleKey: string;
  }> = [];

  for (const customer of customers) {
    result.checked += 1;

    const facts = await recompute(customer);
    if (!facts) continue;

    // Пересчёт сохраняем всегда: даже если тревоги нет, цифры на карточке
    // должны быть свежими.
    await prisma.customer.update({
      where: { id: customer.id },
      data: {
        paymentsCount: facts.paymentsCount,
        firstPaymentAt: facts.firstPaymentAt,
        lastPaymentAt: facts.lastPaymentAt,
        mrrKop: facts.mrrKop,
        anchorDay: facts.anchorDay,
        expectedNextAt: facts.expectedNextAt,
      },
    });

    // У клиента с одним платежом нет расписания, которому можно верить:
    // неизвестно, месячная у него подписка, годовая или конвертированный триал.
    if (facts.paymentsCount < MIN_PAYMENTS) continue;
    if (!facts.expectedNextAt || !facts.lastPaymentAt) continue;

    const dueBy = facts.expectedNextAt.getTime() + GRACE_DAYS * 24 * 3600 * 1000;
    if (now.getTime() <= dueBy) continue;

    const cycleKey = periodKey(facts.expectedNextAt);
    if (customer.missedSignalKey === cycleKey) continue;

    candidates.push({
      id: customer.id,
      leadId: customer.leadId,
      dealId: customer.dealId,
      expectedNextAt: facts.expectedNextAt,
      lastPaymentAt: facts.lastPaymentAt,
      mrrKop: facts.mrrKop,
      cycleKey,
    });
  }

  if (candidates.length === 0) return result;

  if (candidates.length >= MASS_ALARM_LIMIT) {
    // Три клиента разом не уходят. Это проблема интеграции, а не удержания.
    result.massAlarm = true;
    logWarn("retention.mass_alarm", { count: candidates.length });
    await prisma.domainEvent.create({
      data: {
        module: "sales",
        type: "retention.mass_alarm",
        title: `Без платежа сразу ${candidates.length} клиентов — похоже на сбой синка ЮKassa`,
        payload: { count: candidates.length },
      },
    });
    return result;
  }

  for (const candidate of candidates) {
    // Захват ДО создания задачи. Упадёт создание — потеряем одну тревогу;
    // в обратном порядке падение между шагами дало бы новую задачу каждый
    // прогон крона. Ложная тревога дороже пропущенной, поэтому именно так.
    const claimed = await prisma.customer.updateMany({
      where: {
        id: candidate.id,
        status: "ACTIVE",
        OR: [{ missedSignalKey: null }, { missedSignalKey: { not: candidate.cycleKey } }],
      },
      data: {
        missedSignalKey: candidate.cycleKey,
        missedSignalAt: now,
        status: "AT_RISK",
      },
    });
    if (claimed.count !== 1) continue;

    await scheduleFollowUp({
      leadId: candidate.leadId,
      dealId: candidate.dealId ?? undefined,
      dueAt: now,
      note: `Платёж по подписке не пришёл. Ждали ${formatLocal(candidate.expectedNextAt)}, последний был ${formatLocal(candidate.lastPaymentAt)} на ${formatKop(candidate.mrrKop)}.`,
      origin: "AUTO_RULE",
    });

    await prisma.domainEvent.create({
      data: {
        module: "sales",
        type: "customer.payment_missed",
        title: "Платёж по подписке не пришёл",
        payload: {
          customerId: candidate.id,
          leadId: candidate.leadId,
          cycleKey: candidate.cycleKey,
          expectedAt: candidate.expectedNextAt.toISOString(),
        },
      },
    });

    result.alarms += 1;
  }

  if (result.alarms > 0) logInfo("retention.alarms", { count: result.alarms });
  return result;
}

/** Решение владельца: клиент вернулся или ушёл насовсем. */
export async function resolveCustomer(
  customerId: string,
  decision: "recovered" | "churned",
): Promise<boolean> {
  const updated = await prisma.customer.updateMany({
    where: { id: customerId, status: "AT_RISK" },
    data:
      decision === "recovered"
        ? { status: "ACTIVE", missedSignalKey: null, missedSignalAt: null }
        : { status: "CHURNED" },
  });
  return updated.count === 1;
}
