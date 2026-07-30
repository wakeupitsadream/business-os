import { z } from "zod";
import type { TxType } from "@prisma/client";
import type { AgentTool } from "@/core/orchestrator";
import { formatKop, parseAmountToKop } from "@/core/shared/money";
import { formatLocal } from "@/core/shared/time";
import { resolveCategory } from "../categorize";
import { PERIOD_NAMES, explicitRange, resolvePeriod, type PeriodName } from "../period";
import {
  expandCategoryIds,
  listTransactions as queryTransactions,
  sumByCategory,
  sumByType,
} from "../query";
import {
  APPROVAL_THRESHOLD_KOP,
  createTransaction,
  findCategoryByName,
  resolveAccount,
  resolveProject,
} from "../transactions";
import { prisma } from "@/core/db";

/**
 * Финансовые инструменты секретаря.
 *
 * Смысл в том, чтобы учёт не требовал открывать интерфейс: владелец говорит
 * «потратил 3500 на бензин» из Telegram — и операция уже в базе, с категорией.
 * Учёт, который требует сесть за компьютер, не ведётся вовсе.
 */

const AMOUNT = z
  .string()
  .min(1)
  .describe('Сумма как её назвал владелец: "3500", "3,5 тыс", "12к", "1 200,50"');

const PERIOD = z
  .enum(PERIOD_NAMES)
  .describe(
    "Период: today, yesterday, week, prev_week, month (текущий месяц), " +
      "prev_month, quarter (3 месяца), year, all",
  );

export const addTransaction: AgentTool = {
  name: "add_transaction",
  description:
    "Записать доход или расход владельца. Вызывай на фразы вроде «потратил 3500 " +
    "на бензин», «пришло 40 тысяч от клиента», «оплатил хостинг 1200». " +
    "Категорию НЕ выдумывай: если владелец её не назвал, оставь поле пустым — " +
    "система подберёт сама по описанию.",
  schema: z.object({
    direction: z
      .enum(["expense", "income"])
      .describe("expense — деньги ушли, income — деньги пришли"),
    amount: AMOUNT,
    description: z
      .string()
      .min(1)
      .max(300)
      .describe("На что потрачено или откуда пришло, словами владельца: «бензин», «реклама в директе»"),
    category: z.string().max(100).optional().describe("Только если владелец назвал категорию явно"),
    account: z.string().max(100).optional().describe("Счёт, если назван: «наличные», «карта»"),
    project: z.string().max(100).optional().describe("Проект, если назван: «Agentus», «личное»"),
    date: z
      .string()
      .optional()
      .describe("Дата операции в ISO 8601 с часовым поясом, если она не сегодняшняя"),
  }),

  /**
   * Крупные суммы требуют подтверждения. Порог, а не флаг на весь инструмент:
   * спрашивать о каждой чашке кофе значит приучить владельца жать «да» не
   * глядя, и подтверждение перестанет что-либо значить. Ошибка модели в
   * разряде («3 тыс» → 300 000) стоит дорого, и ловится она именно здесь.
   */
  dangerous: (args) => {
    const kop = parseAmountToKop(String((args as { amount?: unknown }).amount ?? ""));
    return kop !== null && kop >= APPROVAL_THRESHOLD_KOP;
  },

  async execute(args, ctx) {
    const input = args as {
      direction: "expense" | "income";
      amount: string;
      description: string;
      category?: string;
      account?: string;
      project?: string;
      date?: string;
    };

    const amountKop = parseAmountToKop(input.amount);
    if (amountKop === null || amountKop <= 0) {
      return {
        ok: false,
        message: `Не разобрал сумму «${input.amount}». Пришли её числом, например 3500 или 3.5 тыс.`,
      };
    }

    const type: TxType = input.direction === "income" ? "INCOME" : "EXPENSE";

    let date = ctx.now;
    if (input.date) {
      const parsed = new Date(input.date);
      if (Number.isNaN(parsed.getTime())) {
        return { ok: false, message: `Не разобрал дату «${input.date}». Нужен формат ISO 8601.` };
      }
      date = parsed;
    }

    const account = await resolveAccount(input.account);
    if (!account) {
      return {
        ok: false,
        message: "В системе нет ни одного счёта — операцию записать некуда. Заведи счёт в разделе «Финансы».",
      };
    }

    const explicit = input.category ? await findCategoryByName(input.category, type) : null;
    const matched = explicit ?? (await resolveCategory(input.description, type));
    const project = await resolveProject(input.project);

    const tx = await createTransaction({
      type,
      amountKop,
      date,
      accountId: account.id,
      categoryId: matched?.id ?? null,
      projectId: project?.id ?? null,
      note: input.description,
      source: ctx.channel === "TELEGRAM" ? "TELEGRAM" : "SECRETARY",
    });

    const head = type === "INCOME" ? "Доход" : "Расход";
    const where = matched ? `, категория «${matched.name}»` : ", БЕЗ категории";
    const proj = project ? `, проект «${project.name}»` : "";

    return {
      ok: true,
      message:
        `${head} ${formatKop(amountKop)} записан на «${account.name}»${where}${proj}. ` +
        (matched
          ? "Скажи владельцу сумму и категорию — вдруг категория не та."
          : "Категорию подобрать не удалось: спроси владельца, к чему это отнести."),
      data: { transactionId: tx.id, amountKop, categoryId: matched?.id ?? null },
    };
  },
};

export const queryFinance: AgentTool = {
  name: "query_finance",
  description:
    "Посчитать доходы и расходы за период. Вызывай на вопросы «сколько ушло на " +
    "рекламу в июле», «какая выручка за месяц», «сколько я трачу». Суммы считает " +
    "база — НЕ складывай их сам и не округляй.",
  schema: z.object({
    period: PERIOD,
    from: z.string().optional().describe("Начало произвольного диапазона (ISO). Только если период не подходит"),
    to: z.string().optional().describe("Конец произвольного диапазона (ISO), включительно"),
    category: z
      .string()
      .max(100)
      .optional()
      .describe("Категория или тема расхода: «реклама», «маркетинг», «налоги»"),
    project: z.string().max(100).optional(),
  }),

  async execute(args, ctx) {
    const input = args as {
      period: PeriodName;
      from?: string;
      to?: string;
      category?: string;
      project?: string;
    };

    const range =
      input.from && input.to
        ? explicitRange(input.from, input.to)
        : resolvePeriod(input.period, ctx.now);
    if (!range) {
      return { ok: false, message: "Не разобрал диапазон дат. Назови период именем, например month." };
    }

    const project = await resolveProject(input.project);
    if (input.project && !project) {
      return { ok: false, message: `Проекта «${input.project}» нет. Уточни у владельца.` };
    }

    // Вопрос о конкретной категории и вопрос «сколько всего» — разные ответы.
    if (input.category) {
      const target = await matchCategoryForQuery(input.category);
      if (!target) {
        return {
          ok: false,
          message: `Категорию «${input.category}» не нашёл. Скажи владельцу, что такой категории нет.`,
        };
      }

      const ids = await expandCategoryIds(target.id);
      const totals = await sumByType({ range, categoryIds: ids, projectId: project?.id });
      const amount = totals.expenseKop > 0 ? totals.expenseKop : totals.incomeKop;

      if (totals.count === 0) {
        return { ok: true, message: `По категории «${target.name}» за ${range.label} операций нет.` };
      }
      return {
        ok: true,
        message:
          `«${target.name}» за ${range.label}: ${formatKop(amount)} ` +
          `(${totals.count} ${plural(totals.count, "операция", "операции", "операций")}).`,
        data: { amountKop: amount, count: totals.count },
      };
    }

    const totals = await sumByType({ range, projectId: project?.id });
    const profit = totals.incomeKop - totals.expenseKop;
    const top = await sumByCategory({ range, projectId: project?.id }, "EXPENSE", 5);

    const lines = [
      `Итоги за ${range.label}${project ? ` по проекту «${project.name}»` : ""}:`,
      `доходы ${formatKop(totals.incomeKop)}`,
      `расходы ${formatKop(totals.expenseKop)}`,
      `прибыль ${formatKop(profit, { sign: profit > 0 })}`,
    ];
    if (top.length > 0) {
      lines.push("Крупнейшие расходы: " + top.map((c) => `${c.categoryName} ${formatKop(c.amountKop)}`).join(", "));
    }

    return {
      ok: true,
      message: lines.join("\n"),
      data: { incomeKop: totals.incomeKop, expenseKop: totals.expenseKop, profitKop: profit },
    };
  },
};

export const listRecentTransactions: AgentTool = {
  name: "list_transactions",
  description:
    "Показать последние операции за период. Вызывай на «что я тратил на этой " +
    "неделе», «покажи последние расходы», «куда ушли деньги вчера».",
  schema: z.object({
    period: PERIOD,
    direction: z.enum(["expense", "income", "any"]).optional(),
    limit: z.number().int().min(1).max(30).optional(),
  }),

  async execute(args, ctx) {
    const input = args as { period: PeriodName; direction?: string; limit?: number };
    const range = resolvePeriod(input.period, ctx.now);

    const type: TxType | undefined =
      input.direction === "income" ? "INCOME" : input.direction === "expense" ? "EXPENSE" : undefined;

    const rows = await queryTransactions({ range }, { type, limit: input.limit ?? 15 });
    if (rows.length === 0) {
      return { ok: true, message: `За ${range.label} операций нет.` };
    }

    const lines = rows.map((t) => {
      const sign = t.type === "INCOME" ? "+" : "−";
      const category = t.category?.name ?? "без категории";
      const what = t.counterparty ?? t.note ?? category;
      return `${formatLocal(t.date).slice(0, 10)} ${sign}${formatKop(t.amountKop)} — ${what} (${category})`;
    });

    return {
      ok: true,
      message: `Операции за ${range.label} (${rows.length}):\n${lines.join("\n")}`,
      data: { count: rows.length },
    };
  },
};

/**
 * Категория для вопроса владельца. Точное имя, затем — тот же подбор по
 * алиасам, что и при записи: «на рекламу» обязано находить «Рекламу» и в
 * вопросе тоже, иначе инструмент отвечает «нет такой категории» на очевидное.
 */
async function matchCategoryForQuery(text: string): Promise<{ id: string; name: string } | null> {
  const exact = await prisma.category.findFirst({
    where: { isArchived: false, name: { equals: text.trim(), mode: "insensitive" } },
    select: { id: true, name: true },
  });
  if (exact) return exact;

  for (const type of ["EXPENSE", "INCOME"] as const) {
    const hit = await resolveCategory(text, type, { allowLlm: false });
    if (hit) return { id: hit.id, name: hit.name };
  }
  return null;
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = n % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}
