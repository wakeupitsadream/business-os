import { NextResponse } from "next/server";
import { z } from "zod";
import { isAuthenticated } from "@/core/auth/session";
import { logWarn } from "@/core/observability/logger";
import { parseAmountToKop } from "@/core/shared/money";
import { resolveCategory } from "@/modules/finance/categorize";
import {
  createTransaction,
  findCategoryByName,
  resolveAccount,
  resolveProject,
  TransactionInputError,
} from "@/modules/finance/transactions";

/**
 * Быстрый ввод операции с экрана.
 *
 * Проходит через те же `resolveCategory` и `createTransaction`, что и
 * инструмент секретаря. Второй, «свой» путь записи означал бы, что операция,
 * заведённая на экране, категоризуется иначе, чем такая же — из Telegram, и
 * разбивка расходов зависела бы от того, где владелец был в тот момент.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  direction: z.enum(["expense", "income"]),
  amount: z.string().min(1).max(40),
  description: z.string().min(1).max(300),
  category: z.string().max(100).optional(),
  account: z.string().max(100).optional(),
  project: z.string().max(100).optional(),
  date: z.string().max(40).optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Тело запроса не является JSON" }, { status: 400 });
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Проверь поля формы" }, { status: 400 });
  }
  const input = parsed.data;

  const amountKop = parseAmountToKop(input.amount);
  if (amountKop === null || amountKop <= 0) {
    return NextResponse.json({ error: `Не разобрал сумму «${input.amount}»` }, { status: 400 });
  }

  const type = input.direction === "income" ? "INCOME" : "EXPENSE";

  let date = new Date();
  if (input.date) {
    const parsedDate = new Date(input.date);
    if (Number.isNaN(parsedDate.getTime())) {
      return NextResponse.json({ error: "Не разобрал дату" }, { status: 400 });
    }
    date = parsedDate;
  }

  const account = await resolveAccount(input.account);
  if (!account) {
    return NextResponse.json({ error: "Не заведено ни одного счёта" }, { status: 409 });
  }

  const explicit = input.category ? await findCategoryByName(input.category, type) : null;
  // На экране владелец видит результат сразу и поправит категорию сам —
  // тратить вызов модели на подбор здесь незачем.
  const matched = explicit ?? (await resolveCategory(input.description, type, { allowLlm: false }));
  const project = await resolveProject(input.project);

  try {
    const tx = await createTransaction({
      type,
      amountKop,
      date,
      accountId: account.id,
      categoryId: matched?.id ?? null,
      projectId: project?.id ?? null,
      note: input.description,
      source: "MANUAL",
    });

    return NextResponse.json({
      ok: true,
      id: tx.id,
      amountKop,
      category: matched?.name ?? null,
      account: account.name,
    });
  } catch (e) {
    if (e instanceof TransactionInputError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    logWarn("finance.manual_entry_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ error: "Не удалось записать операцию" }, { status: 500 });
  }
}
