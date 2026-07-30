import { z } from "zod";
import { prisma } from "@/core/db";
import type { AgentTool } from "@/core/orchestrator";
import { formatLocal } from "@/core/shared/time";
import { describeRepeat } from "../schedule";
import { parseWhen } from "./when";
import { noteReminderDue } from "../reminder-cursor";

export const setReminder: AgentTool = {
  name: "set_reminder",
  description:
    "Поставить напоминание — оно придёт владельцу в Telegram в назначенное время. " +
    "Вызывай на «напомни», «не дай забыть», «пни меня». Для повторяющихся " +
    "используй repeat. Время считай от текущего момента из системного промпта.",
  schema: z.object({
    text: z.string().min(1).max(500).describe("О чём напомнить, от первого лица владельца"),
    when: z
      .string()
      .describe("Когда, в формате ISO 8601 с часовым поясом: 2026-07-30T10:00:00+03:00"),
    repeat: z
      .enum(["DAILY", "WEEKDAYS", "WEEKLY", "MONTHLY"])
      .optional()
      .describe("Повтор. Не указывай, если напоминание разовое"),
  }),
  async execute(args, ctx) {
    const { text, when, repeat } = args as {
      text: string;
      when: string;
      repeat?: "DAILY" | "WEEKDAYS" | "WEEKLY" | "MONTHLY";
    };

    const parsed = parseWhen(when, ctx.now);
    if (!parsed.ok) return { ok: false, message: parsed.error };

    const reminder = await prisma.reminder.create({
      data: {
        text: text.trim(),
        nextFireAt: parsed.date,
        repeatPreset: repeat ?? null,
        channel: "TELEGRAM",
        source: ctx.channel === "TELEGRAM" ? "TELEGRAM" : "AGENT",
      },
      select: { id: true, text: true, nextFireAt: true, repeatPreset: true },
    });

    // Курсор обязан узнать о новом сроке немедленно: иначе крон продолжит
    // спать до прежнего ближайшего времени и напоминание опоздает.
    noteReminderDue(reminder.nextFireAt);

    const repeatNote = reminder.repeatPreset ? `, ${describeRepeat(reminder.repeatPreset)}` : "";
    return {
      ok: true,
      message: `Напомню ${formatLocal(reminder.nextFireAt)}${repeatNote}: «${reminder.text}»`,
      data: { reminderId: reminder.id },
    };
  },
};

export const listReminders: AgentTool = {
  name: "list_reminders",
  description: "Показать активные напоминания владельца.",
  schema: z.object({
    limit: z.number().int().min(1).max(50).optional(),
  }),
  async execute(args) {
    const { limit = 20 } = args as { limit?: number };

    const rows = await prisma.reminder.findMany({
      where: { isActive: true },
      orderBy: { nextFireAt: "asc" },
      take: limit,
      select: { id: true, text: true, nextFireAt: true, repeatPreset: true },
    });

    if (rows.length === 0) return { ok: true, message: "Активных напоминаний нет." };

    const lines = rows.map((r) => {
      const repeat = r.repeatPreset ? ` (${describeRepeat(r.repeatPreset)})` : "";
      return `${formatLocal(r.nextFireAt)} — ${r.text}${repeat} [id: ${r.id}]`;
    });
    return { ok: true, message: `Напоминания (${rows.length}):\n${lines.join("\n")}` };
  },
};

export const cancelReminder: AgentTool = {
  name: "cancel_reminder",
  description: "Отменить напоминание по id. Найти id можно через list_reminders.",
  schema: z.object({ reminderId: z.string().min(1) }),
  async execute(args) {
    const { reminderId } = args as { reminderId: string };

    const existing = await prisma.reminder.findUnique({
      where: { id: reminderId },
      select: { id: true, text: true, isActive: true },
    });
    if (!existing) {
      return { ok: false, message: `Напоминания с id ${reminderId} нет.` };
    }
    if (!existing.isActive) {
      return { ok: true, message: `Напоминание «${existing.text}» уже было отменено.` };
    }

    await prisma.reminder.update({ where: { id: reminderId }, data: { isActive: false } });
    return { ok: true, message: `Отменила: «${existing.text}»` };
  },
};
