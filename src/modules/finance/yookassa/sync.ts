import type { Prisma } from "@prisma/client";
import { prisma } from "@/core/db";
import { logInfo, logWarn } from "@/core/observability/logger";
import { createTransaction } from "../transactions";
import { categorizeImportedRow, loadRuleSets } from "../import/rules";
import { fetchSucceededPayments, yooConfigured, YooKassaError } from "./client";
import { yooAmountToKop, type YooPayment } from "./types";

/**
 * Синхронизация поступлений ЮKassa.
 *
 * Единственный источник выручки Agentus на старте, поэтому здесь важнее не
 * скорость, а два свойства: не потерять платёж и не посчитать его дважды.
 */

/** Идентификатор счёта из сид-миграции. */
export const YOOKASSA_ACCOUNT_ID = "acc_yookassa";

/**
 * Перекрытие окна — страховка от расхождения часов и гонок на границе.
 *
 * Раньше этот комментарий утверждал, что перекрытие спасает от позднего
 * `succeeded`. Это было неправдой, и именно она прятала находку: выборка шла
 * по дате СОЗДАНИЯ платежа, и никакое перекрытие в 48 часов не помогало
 * платежу, подтверждённому позже. Теперь выборка идёт по дате подтверждения
 * (см. client.ts), и от позднего подтверждения защищает она, а не перекрытие.
 */
const OVERLAP_MS = 48 * 60 * 60 * 1000;

/**
 * Ключ подписки из metadata платежа.
 *
 * Два написания, потому что metadata заполняет Agentus — отдельная кодовая
 * база, и snake_case там обычное дело. Ошибиться регистром в одном месте
 * дешевле, чем потом гадать, почему удержание не видит половину клиентов.
 */
const SUBSCRIPTION_KEYS = ["subscriptionId", "subscription_id"] as const;

export function readSubscriptionId(meta: Record<string, unknown> | undefined): string | null {
  for (const key of SUBSCRIPTION_KEYS) {
    const value = meta?.[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** С какой даты собирать, если синк ни разу не запускался. */
const COLD_START_DAYS = 90;

export interface SyncResult {
  configured: boolean;
  fetched: number;
  createdIncome: number;
  createdFees: number;
  skippedExisting: number;
  reason?: string;
}

export interface SyncOptions {
  /**
   * Минимальная глубина окна. Суточный контрольный прогон просит 30 дней:
   * фильтр по дате подтверждения закрывает известную потерю, а контрольное
   * окно — всё остальное, чего мы ещё не знаем (сбой прогона, расхождение
   * часов, изменение поведения API). Дедуп синка по externalId делает лишний
   * проход бесплатным: уже записанные платежи попадут в skippedExisting.
   */
  minLookbackMs?: number;
}

export async function syncYooKassa(
  now: Date = new Date(),
  opts: SyncOptions = {},
): Promise<SyncResult> {
  if (!yooConfigured()) {
    // Ненастроенная интеграция — это не сбой. Половина системы не должна
    // выглядеть сломанной из-за того, что ключей ещё нет.
    return {
      configured: false,
      fetched: 0,
      createdIncome: 0,
      createdFees: 0,
      skippedExisting: 0,
      reason: "ключи ЮKassa не заданы",
    };
  }

  const account = await prisma.account.findUnique({
    where: { id: YOOKASSA_ACCOUNT_ID },
    select: { id: true, lastSyncedAt: true },
  });
  if (!account) {
    throw new YooKassaError("Счёт «ЮKassa» не найден — не применилась миграция", "config");
  }

  const normalSince = account.lastSyncedAt
    ? new Date(account.lastSyncedAt.getTime() - OVERLAP_MS)
    : new Date(now.getTime() - COLD_START_DAYS * 24 * 60 * 60 * 1000);

  // Math.min, а не подмена: при холодном старте штатное окно в 90 дней шире
  // контрольных 30, и контрольный прогон не должен его сужать.
  const since = opts.minLookbackMs
    ? new Date(Math.min(normalSince.getTime(), now.getTime() - opts.minLookbackMs))
    : normalSince;

  const payments = await fetchSucceededPayments({ since });
  const sets = await loadRuleSets("INCOME");
  const feeSets = await loadRuleSets("EXPENSE");

  let createdIncome = 0;
  let createdFees = 0;
  let skippedExisting = 0;

  for (const payment of payments) {
    const written = await writePayment(payment, { sets, feeSets });
    createdIncome += written.income;
    createdFees += written.fee;
    if (written.income === 0 && written.fee === 0) skippedExisting += 1;
  }

  // Курсор двигаем ТОЛЬКО после успешной записи всех платежей. Сдвинуть его
  // раньше — значит при падении на середине потерять хвост навсегда.
  await prisma.account.update({
    where: { id: account.id },
    data: { lastSyncedAt: now },
  });

  logInfo("yookassa.synced", {
    fetched: payments.length,
    createdIncome,
    createdFees,
    skippedExisting,
  });

  return {
    configured: true,
    fetched: payments.length,
    createdIncome,
    createdFees,
    skippedExisting,
  };
}

interface WriteContext {
  sets: Awaited<ReturnType<typeof loadRuleSets>>;
  feeSets: Awaited<ReturnType<typeof loadRuleSets>>;
}

/**
 * Проводка одного платежа: доход и комиссия.
 *
 * **Доход — это `amount`, то есть сколько заплатил клиент, а не
 * `income_amount`.** В `PLAN.md` было написано наоборот, и это ошибка:
 * `income_amount` уже за вычетом комиссии, и парная операция «комиссия
 * эквайринга» вычла бы её второй раз — прибыль оказалась бы занижена ровно на
 * комиссию, причём незаметно.
 *
 * Правильная пара: доход по сумме клиента + расход на разницу. Тогда и
 * выручка настоящая (та, что владелец видит в кабинете ЮKassa), и стоимость
 * эквайринга видна отдельной строкой — а без неё непонятно, во что обходится
 * приём платежей.
 */
export async function writePayment(
  payment: YooPayment,
  ctx: WriteContext,
): Promise<{ income: number; fee: number }> {
  const grossKop = yooAmountToKop(payment.amount.value);
  if (grossKop === null || grossKop <= 0) {
    logWarn("yookassa.bad_amount", { paymentId: payment.id, value: payment.amount.value });
    return { income: 0, fee: 0 };
  }

  if (payment.amount.currency !== "RUB") {
    // Одна валюта в системе — конвертация по курсу на дату это отдельная
    // работа. Записать доллары как рубли хуже, чем пропустить и сказать.
    logWarn("yookassa.foreign_currency", {
      paymentId: payment.id,
      currency: payment.amount.currency,
    });
    return { income: 0, fee: 0 };
  }

  const date = new Date(payment.captured_at ?? payment.created_at);
  const description = payment.description?.trim() || "Платёж ЮKassa";

  const netKop = payment.income_amount ? yooAmountToKop(payment.income_amount.value) : null;
  const feeKop = netKop !== null && netKop > 0 && netKop < grossKop ? grossKop - netKop : 0;

  const category = categorizeImportedRow({ description }, ctx.sets);
  const feeCategory = categorizeImportedRow({ description: "комиссия эквайринга" }, ctx.feeSets);

  const income = await insertOnce({
    type: "INCOME",
    amountKop: grossKop,
    date,
    categoryId: category?.id ?? null,
    note: description,
    externalId: payment.id,
    // Только строке дохода: комиссия — вторая строка того же платежа, и с тем
    // же ключом она удвоила бы счётчик платежей клиента.
    subscriptionId: readSubscriptionId(payment.metadata),
    meta: buildMeta(payment, netKop, feeKop),
  });

  let fee = 0;
  if (feeKop > 0) {
    fee = await insertOnce({
      type: "EXPENSE",
      amountKop: feeKop,
      date,
      categoryId: feeCategory?.id ?? null,
      note: `Комиссия эквайринга — ${description}`,
      // Свой externalId: без суффикса вторая операция того же платежа
      // конфликтовала бы с первой по (source, externalId).
      externalId: `${payment.id}:fee`,
      meta: { paymentId: payment.id, kind: "acquiring_fee" },
    });
  }

  return { income, fee };
}

interface InsertInput {
  type: "INCOME" | "EXPENSE";
  amountKop: number;
  date: Date;
  categoryId: string | null;
  note: string;
  externalId: string;
  subscriptionId?: string | null;
  meta: Prisma.InputJsonValue;
}

/**
 * Запись с опорой на уникальный индекс `(source, externalId)`.
 *
 * Проверка «есть ли уже» делается запросом, а не только ловлей ошибки: так
 * повторный прогон не пишет в лог базы поток нарушений ограничения. Но и
 * ошибку ловим — между проверкой и вставкой может пройти параллельный прогон.
 */
async function insertOnce(input: InsertInput): Promise<number> {
  const existing = await prisma.transaction.findFirst({
    where: { source: "YOOKASSA", externalId: input.externalId },
    select: { id: true },
  });
  if (existing) return 0;

  try {
    await createTransaction({
      type: input.type,
      amountKop: input.amountKop,
      date: input.date,
      accountId: YOOKASSA_ACCOUNT_ID,
      categoryId: input.categoryId,
      note: input.note,
      source: "YOOKASSA",
      externalId: input.externalId,
      subscriptionId: input.subscriptionId ?? null,
      meta: input.meta,
    });
    return 1;
  } catch (e) {
    if (isUniqueViolation(e)) return 0;
    throw e;
  }
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

function buildMeta(
  payment: YooPayment,
  netKop: number | null,
  feeKop: number,
): Prisma.InputJsonValue {
  return {
    paymentId: payment.id,
    grossKop: yooAmountToKop(payment.amount.value),
    netKop,
    feeKop,
    // metadata платежа пригодится в фазе «Продажи»: там по ней матчится
    // подписка на клиента. Сохраняем сейчас, чтобы потом не переливать.
    metadata: (payment.metadata ?? {}) as Prisma.InputJsonValue,
  };
}
