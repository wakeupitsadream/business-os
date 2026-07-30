import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/core/db";
import type { AgentTool } from "@/core/orchestrator";
import { formatLocal } from "@/core/shared/time";
import { parseWhen } from "./when";

/**
 * Инструменты работы с задачами.
 *
 * Описания написаны для модели, а не для человека: от их точности зависит,
 * догадается ли она вызвать инструмент вовремя и с какими аргументами.
 * Отсюда явные указания вроде «не выдумывай срок, если владелец его не назвал»
 * — без них модель охотно проставляет дедлайны от себя.
 */

const PRIORITY = z
  .number()
  .int()
  .min(1)
  .max(3)
  .describe("1 — срочно и важно, 2 — обычная (по умолчанию), 3 — потом");

export const createTask: AgentTool = {
  name: "create_task",
  description:
    "Создать задачу владельца. Вызывай, когда он просит что-то запомнить, " +
    "сделать или не забыть. Срок ставь ТОЛЬКО если он назван явно.",
  schema: z.object({
    title: z.string().min(1).max(300).describe("Суть задачи в одной строке"),
    note: z.string().max(2000).optional().describe("Подробности, если они были"),
    priority: PRIORITY.optional(),
    dueAt: z
      .string()
      .optional()
      .describe("Срок в формате ISO 8601 с часовым поясом, например 2026-07-30T10:00:00+03:00"),
  }),
  async execute(args, ctx) {
    const { title, note, priority, dueAt } = args as {
      title: string;
      note?: string;
      priority?: number;
      dueAt?: string;
    };

    let due: Date | null = null;
    if (dueAt) {
      const parsed = parseWhen(dueAt, ctx.now);
      if (!parsed.ok) return { ok: false, message: parsed.error };
      due = parsed.date;
    }

    const task = await prisma.task.create({
      data: {
        title: title.trim(),
        note: note?.trim() || null,
        priority: priority ?? 2,
        dueAt: due,
        module: "personal",
        source: ctx.channel === "TELEGRAM" ? "TELEGRAM" : "AGENT",
      },
      select: { id: true, title: true, dueAt: true },
    });

    const when = task.dueAt ? `, срок ${formatLocal(task.dueAt)}` : "";
    return {
      ok: true,
      message: `Задача создана: «${task.title}»${when}`,
      data: { taskId: task.id },
    };
  },
};

export const listTasks: AgentTool = {
  name: "list_tasks",
  description:
    "Показать задачи владельца. Вызывай на вопросы «что у меня по задачам», " +
    "«что на сегодня», «что просрочено». Без аргументов вернёт открытые задачи.",
  schema: z.object({
    scope: z
      .enum(["open", "today", "overdue", "done"])
      .optional()
      .describe("open — все незакрытые (по умолчанию), today — со сроком сегодня"),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  async execute(args, ctx) {
    const { scope = "open", limit = 20 } = args as { scope?: string; limit?: number };

    const where = buildWhere(scope, ctx.now);
    const tasks = await prisma.task.findMany({
      where,
      orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { priority: "asc" }],
      take: limit,
      select: { id: true, title: true, dueAt: true, priority: true, status: true },
    });

    if (tasks.length === 0) {
      return { ok: true, message: emptyMessage(scope) };
    }

    // Модели отдаём готовые строки, а не структуру: она перескажет их владельцу,
    // и из строк получается естественная речь, а из JSON — зачитывание полей.
    const lines = tasks.map((t) => {
      const mark = t.priority === 1 ? "!" : "";
      const due = t.dueAt ? ` — до ${formatLocal(t.dueAt)}` : "";
      const overdue = t.dueAt && t.dueAt < ctx.now && t.status !== "DONE" ? " (просрочена)" : "";
      return `${mark}${t.title}${due}${overdue} [id: ${t.id}]`;
    });

    return {
      ok: true,
      message: `${headerFor(scope)} (${tasks.length}):\n${lines.join("\n")}`,
      data: { count: tasks.length },
    };
  },
};

export const completeTask: AgentTool = {
  name: "complete_task",
  description:
    "Отметить задачу выполненной. Нужен её id — если владелец назвал задачу " +
    "словами, сначала найди её через list_tasks.",
  schema: z.object({
    taskId: z.string().min(1).describe("Идентификатор задачи из list_tasks"),
  }),
  async execute(args) {
    const { taskId } = args as { taskId: string };

    const existing = await prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, title: true, status: true },
    });
    if (!existing) {
      // Модель могла выдумать id. Честный ответ лучше молчаливого «готово».
      return { ok: false, message: `Задачи с id ${taskId} нет. Уточни через list_tasks.` };
    }
    if (existing.status === "DONE") {
      return { ok: true, message: `Задача «${existing.title}» уже была отмечена выполненной.` };
    }

    await prisma.task.update({
      where: { id: taskId },
      data: { status: "DONE", completedAt: new Date() },
    });
    return { ok: true, message: `Готово: «${existing.title}» отмечена выполненной.` };
  },
};

function buildWhere(scope: string, now: Date): Prisma.TaskWhereInput {
  const open: Prisma.TaskWhereInput["status"] = { in: ["TODO", "IN_PROGRESS"] };

  switch (scope) {
    case "done":
      return { status: "DONE" };
    case "overdue":
      return { status: open, dueAt: { lt: now } };
    case "today": {
      const end = new Date(now);
      end.setHours(23, 59, 59, 999);
      return { status: open, dueAt: { lte: end } };
    }
    default:
      return { status: open };
  }
}

function headerFor(scope: string): string {
  if (scope === "done") return "Выполненные задачи";
  if (scope === "overdue") return "Просроченные задачи";
  if (scope === "today") return "Задачи на сегодня";
  return "Открытые задачи";
}

function emptyMessage(scope: string): string {
  if (scope === "overdue") return "Просроченных задач нет.";
  if (scope === "today") return "На сегодня задач со сроком нет.";
  if (scope === "done") return "Выполненных задач пока нет.";
  return "Открытых задач нет.";
}
