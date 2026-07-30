import { createHash } from "node:crypto";
import type { Prisma, TxSource, TxType } from "@prisma/client";
import { prisma } from "@/core/db";
import { assertKopInRange } from "@/core/shared/money";
import { dayKey } from "@/core/shared/time";
import { normalizeText } from "./text";

/**
 * Запись операций — единственное место, где строки попадают в Transaction.
 *
 * Проверки собраны здесь, а не в инструменте агента, потому что писать будут
 * трое: секретарь из диалога, импорт выписки и синк ЮKassa. Разъехавшиеся
 * правила «что такое корректная операция» — это расхождение с банком, которое
 * потом ищут по одной строке.
 */

export const APPROVAL_THRESHOLD_KOP = 50_000_00;

export interface CreateTransactionInput {
  type: TxType;
  /** ВСЕГДА положительная: направление задаёт type. */
  amountKop: number;
  date: Date;
  accountId: string;
  transferAccountId?: string | null;
  categoryId?: string | null;
  projectId?: string | null;
  counterparty?: string | null;
  note?: string | null;
  source?: TxSource;
  externalId?: string | null;
  /** Ключ дедупа. Задаётся ТОЛЬКО пакетными источниками — см. buildDedupKey. */
  dedupKey?: string | null;
  importBatchId?: string | null;
  meta?: Prisma.InputJsonValue | null;
}

export class TransactionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransactionInputError";
  }
}

/**
 * Клиент Prisma: обычный или транзакционный.
 *
 * Нужен импорту выписки: сотня строк обязана лечь целиком или не лечь вовсе,
 * а для этого они пишутся внутри одной `$transaction`. Без этого параметра
 * импорту пришлось бы завести вторую точку записи в обход всех проверок ниже —
 * и правила «что такое корректная операция» разъехались бы на второй неделе.
 */
type TxClient = Prisma.TransactionClient | typeof prisma;

export async function createTransaction(
  input: CreateTransactionInput,
  client: TxClient = prisma,
) {
  if (!Number.isInteger(input.amountKop) || input.amountKop <= 0) {
    // Отрицательная сумма означала бы, что направление задано дважды — типом и
    // знаком, — и однажды они разойдутся.
    throw new TransactionInputError("сумма должна быть положительным числом копеек");
  }
  assertKopInRange(input.amountKop);

  if (input.type === "TRANSFER") {
    if (!input.transferAccountId) {
      throw new TransactionInputError("для перевода нужен счёт-получатель");
    }
    if (input.transferAccountId === input.accountId) {
      throw new TransactionInputError("перевод на тот же счёт не имеет смысла");
    }
  }

  return client.transaction.create({
    data: {
      type: input.type,
      date: input.date,
      amountKop: input.amountKop,
      accountId: input.accountId,
      transferAccountId: input.transferAccountId ?? null,
      categoryId: input.categoryId ?? null,
      projectId: input.projectId ?? null,
      counterparty: input.counterparty?.trim() || null,
      note: input.note?.trim() || null,
      source: input.source ?? "MANUAL",
      externalId: input.externalId ?? null,
      dedupKey: input.dedupKey ?? null,
      importBatchId: input.importBatchId ?? null,
      meta: input.meta ?? undefined,
    },
    select: {
      id: true,
      type: true,
      date: true,
      amountKop: true,
      categoryId: true,
      accountId: true,
      projectId: true,
    },
  });
}

/**
 * Ключ дедупа для пакетных источников: счёт + день + направление + сумма +
 * описание.
 *
 * Ручному вводу он НЕ ставится, и это осознанно. Две чашки кофе по 200 ₽ в
 * один день на одном счёте — законная пара операций, а уникальный индекс
 * отверг бы вторую как дубль. У выписки же наоборот: повторная загрузка того
 * же файла обязана давать ноль новых строк. NULL в Postgres не конфликтует
 * сам с собой, поэтому пустой ключ у ручных операций ограничение не трогает.
 *
 * День режется по МОСКВЕ, как и все периоды системы. Через `toISOString()`
 * ключ разъезжался бы сам с собой: банк выгружает одну и ту же операцию то с
 * временем (14:00 МСК → UTC-день тот же), то без времени (00:00 МСК → UTC-день
 * ПРЕДЫДУЩИЙ), и повторный импорт создавал бы дубли — ровно то, ради чего ключ
 * и заведён.
 *
 * Направление в ключе обязательно. Возврат по покупке приходит в тот же день,
 * на тот же счёт, с тем же названием магазина и той же суммой — без типа он
 * получил бы хэш покупки и был бы молча съеден как дубль. Деньги при этом
 * пропадают из учёта, и заметить это владелец не может ничем.
 */
export function buildDedupKey(params: {
  accountId: string;
  date: Date;
  amountKop: number;
  description: string;
  type: TxType;
}): string {
  const payload = [
    params.accountId,
    dayKey(params.date),
    params.type,
    String(params.amountKop),
    normalizeText(params.description),
  ].join("|");
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Счёт для операции.
 *
 * Владелец почти никогда не называет счёт («потратил 3500 на бензин»), поэтому
 * без счёта по умолчанию инструмент был бы неработоспособен. Выбор
 * детерминирован: сначала явно помеченный, при равенстве — самый старый.
 */
export async function resolveAccount(hint?: string | null) {
  if (hint && hint.trim().length > 0) {
    const needle = hint.trim();
    const byName = await prisma.account.findFirst({
      where: { isArchived: false, name: { contains: needle, mode: "insensitive" } },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      select: { id: true, name: true },
    });
    if (byName) return byName;
  }

  return prisma.account.findFirst({
    where: { isArchived: false },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { id: true, name: true },
  });
}

/** Проект по названию или слагу. Спец-проект «—» намеренно не подставляется. */
export async function resolveProject(hint?: string | null) {
  if (!hint || hint.trim().length === 0) return null;
  const needle = hint.trim();

  return prisma.project.findFirst({
    where: {
      isArchived: false,
      OR: [
        { slug: needle.toLowerCase() },
        { name: { contains: needle, mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true },
  });
}

/** Категория, названная владельцем явно («запиши в Обучение»). */
export async function findCategoryByName(name: string, type: TxType) {
  const needle = name.trim();
  if (needle.length === 0) return null;

  return prisma.category.findFirst({
    where: { type, isArchived: false, name: { equals: needle, mode: "insensitive" } },
    select: { id: true, name: true },
  });
}
