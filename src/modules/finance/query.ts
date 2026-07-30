import type { Prisma, TxType } from "@prisma/client";
import { prisma } from "@/core/db";
import type { Range } from "./period";

/**
 * Чтение финансов.
 *
 * Суммы считает база агрегатом, а не модель по списку операций. Это не
 * оптимизация: модель, которой дали двести строк и попросили сложить, ошибается
 * — и ошибается правдоподобно, красивым круглым числом. Цифра, названная
 * владельцу, должна быть той же, что вернёт `SELECT SUM(...)`.
 */

export interface TotalsRow {
  incomeKop: number;
  expenseKop: number;
  count: number;
}

export interface CategoryTotal {
  categoryId: string | null;
  categoryName: string;
  amountKop: number;
  count: number;
}

interface Filters {
  range: Range;
  categoryIds?: string[];
  projectId?: string;
  accountId?: string;
}

/**
 * Переводы исключены из всех итогов намеренно: перекладывание денег между
 * своими счетами — не доход и не расход, а в сумме оно раздувает и то и другое.
 */
function baseWhere(filters: Filters): Prisma.TransactionWhereInput {
  const where: Prisma.TransactionWhereInput = {
    date: { gte: filters.range.start, lt: filters.range.end },
    type: { in: ["INCOME", "EXPENSE"] },
  };
  if (filters.categoryIds && filters.categoryIds.length > 0) {
    where.categoryId = { in: filters.categoryIds };
  }
  if (filters.projectId) where.projectId = filters.projectId;
  if (filters.accountId) where.accountId = filters.accountId;
  return where;
}

export async function sumByType(filters: Filters): Promise<TotalsRow> {
  const rows = await prisma.transaction.groupBy({
    by: ["type"],
    where: baseWhere(filters),
    _sum: { amountKop: true },
    _count: { _all: true },
  });

  let incomeKop = 0;
  let expenseKop = 0;
  let count = 0;
  for (const row of rows) {
    const sum = row._sum.amountKop ?? 0;
    count += row._count._all;
    if (row.type === "INCOME") incomeKop += sum;
    else if (row.type === "EXPENSE") expenseKop += sum;
  }
  return { incomeKop, expenseKop, count };
}

/** Разбивка по категориям — то, из чего строится ответ «на что ушли деньги». */
export async function sumByCategory(
  filters: Filters,
  type: TxType,
  limit = 10,
): Promise<CategoryTotal[]> {
  const rows = await prisma.transaction.groupBy({
    by: ["categoryId"],
    where: { ...baseWhere(filters), type },
    _sum: { amountKop: true },
    _count: { _all: true },
    orderBy: { _sum: { amountKop: "desc" } },
    take: limit,
  });

  const ids = rows.map((r) => r.categoryId).filter((id): id is string => id !== null);
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const categories = await prisma.category.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    for (const c of categories) names.set(c.id, c.name);
  }

  return rows.map((r) => ({
    categoryId: r.categoryId,
    // Операции без категории существуют и не должны молча исчезать из
    // разбивки: именно они показывают, чего не хватает в справочнике.
    categoryName: r.categoryId ? (names.get(r.categoryId) ?? "—") : "Без категории",
    amountKop: r._sum.amountKop ?? 0,
    count: r._count._all,
  }));
}

/**
 * Идентификаторы категории и всех её подкатегорий.
 *
 * «Сколько ушло на маркетинг» обязано включать «Рекламу» и «Контент»: иначе
 * ответ по родительской категории почти всегда ноль, и он выглядит как правда.
 */
export async function expandCategoryIds(categoryId: string): Promise<string[]> {
  const children = await prisma.category.findMany({
    where: { parentId: categoryId },
    select: { id: true },
  });
  return [categoryId, ...children.map((c) => c.id)];
}

export async function listTransactions(
  filters: Filters,
  opts?: { type?: TxType; limit?: number },
) {
  return prisma.transaction.findMany({
    where: {
      ...baseWhere(filters),
      ...(opts?.type ? { type: opts.type } : {}),
    },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: opts?.limit ?? 20,
    select: {
      id: true,
      type: true,
      date: true,
      amountKop: true,
      note: true,
      counterparty: true,
      category: { select: { name: true } },
      account: { select: { name: true } },
      project: { select: { name: true } },
    },
  });
}
