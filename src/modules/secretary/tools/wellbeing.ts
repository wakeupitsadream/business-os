import { z } from "zod";
import { prisma } from "@/core/db";
import type { AgentTool } from "@/core/orchestrator";
import { formatKop } from "@/core/shared/money";
import { periodKey } from "@/core/shared/time";
import { latestCheckIn, recentCheckIns, upsertCheckIn } from "../checkin";

/**
 * Инструменты состояния и целей.
 *
 * Отдельно стоит сказать, зачем секретарю вообще знать про настроение. Не для
 * сочувствия ради сочувствия: зная, что энергия третий день на двойке, он не
 * предложит «добить ещё две задачи» — и это тот случай, когда система приносит
 * пользу, ничего не делая.
 */

const SCALE = z.number().int().min(1).max(5);

export const logCheckIn: AgentTool = {
  name: "log_checkin",
  description:
    "Записать состояние владельца, когда он сам о нём говорит («выжат», " +
    "«отлично себя чувствую», «не спал»). Оценки 1–5. Специально спрашивать " +
    "не нужно — для этого есть вечерний чек-ин.",
  schema: z.object({
    mood: SCALE.optional().describe("Настроение: 1 — плохо, 5 — отлично"),
    energy: SCALE.optional().describe("Энергия: 1 — на нуле, 5 — полон сил"),
    stress: SCALE.optional().describe("Напряжение: 1 — спокоен, 5 — на пределе"),
    note: z.string().max(500).optional().describe("Своими словами, если сказал"),
  }),
  sensitiveArgs: ["note"],
  async execute(args, ctx) {
    const input = args as { mood?: number; energy?: number; stress?: number; note?: string };
    if (
      input.mood === undefined &&
      input.energy === undefined &&
      input.stress === undefined &&
      !input.note
    ) {
      return { ok: false, message: "Нечего записывать: не указана ни одна оценка." };
    }

    const saved = await upsertCheckIn({ ...input, now: ctx.now });
    return {
      ok: true,
      message: "Отметила состояние.",
      data: { mood: saved.mood, energy: saved.energy },
    };
  },
};

export const getWellbeing: AgentTool = {
  name: "get_wellbeing",
  description:
    "Посмотреть, как владелец себя чувствовал в последние дни. Вызывай перед " +
    "тем, как советовать нагрузку или планировать день.",
  schema: z.object({ days: z.number().int().min(1).max(30).optional() }),
  async execute(args, ctx) {
    const { days = 7 } = args as { days?: number };

    const [last, history] = await Promise.all([
      latestCheckIn(),
      recentCheckIns(days, ctx.now),
    ]);

    if (!last && history.length === 0) {
      return { ok: true, message: "Чек-инов пока нет — состояние неизвестно." };
    }

    const scored = history.filter((h) => h.mood !== null || h.energy !== null);
    const avg = (pick: (r: (typeof scored)[number]) => number | null) => {
      const values = scored.map(pick).filter((v): v is number => v !== null);
      if (values.length === 0) return null;
      return (values.reduce((a, b) => a + b, 0) / values.length).toFixed(1);
    };

    const lines = [
      last
        ? `Последний чек-ин: настроение ${last.mood ?? "—"}/5, энергия ${last.energy ?? "—"}/5`
        : "Последний чек-ин: нет",
      `Среднее за ${days} дн.: настроение ${avg((r) => r.mood) ?? "—"}, энергия ${avg((r) => r.energy) ?? "—"}`,
      `Записей: ${scored.length}`,
    ];

    return { ok: true, message: lines.join("\n"), data: { entries: scored.length } };
  },
};

export const setLifeAreaScore: AgentTool = {
  name: "set_life_area_score",
  description:
    "Поставить оценку сфере жизни за текущий месяц (колесо баланса), 1–10. " +
    "Сферы: business, finance, health, relations, growth, rest, home, meaning.",
  schema: z.object({
    area: z
      .enum(["business", "finance", "health", "relations", "growth", "rest", "home", "meaning"])
      .describe("Идентификатор сферы"),
    score: z.number().int().min(1).max(10),
    note: z.string().max(300).optional(),
  }),
  async execute(args, ctx) {
    const { area, score, note } = args as { area: string; score: number; note?: string };

    const lifeArea = await prisma.lifeArea.findUnique({
      where: { slug: area },
      select: { id: true, name: true },
    });
    if (!lifeArea) return { ok: false, message: `Сферы «${area}» нет.` };

    const period = periodKey(ctx.now);
    await prisma.lifeAreaScore.upsert({
      where: { areaId_period: { areaId: lifeArea.id, period } },
      update: { score, note: note ?? null },
      create: { areaId: lifeArea.id, period, score, note: note ?? null },
    });

    return { ok: true, message: `${lifeArea.name}: ${score}/10 за ${period}.` };
  },
};

export const createGoal: AgentTool = {
  name: "create_goal",
  description:
    "Создать цель владельца. Денежные суммы указывай В РУБЛЯХ — система сама " +
    "переведёт. Ставь цель только когда владелец её назвал, не придумывай.",
  schema: z.object({
    title: z.string().min(3).max(200),
    metricName: z.string().max(60).optional().describe("Что измеряем: «выручка», «клиенты»"),
    targetValue: z.number().optional().describe("Целевое значение; для денег — в рублях"),
    isMoney: z.boolean().optional().describe("true, если цель денежная"),
    area: z
      .enum(["business", "finance", "health", "relations", "growth", "rest", "home", "meaning"])
      .optional(),
    deadline: z.string().optional().describe("Срок в ISO 8601 с часовым поясом"),
  }),
  async execute(args) {
    const { title, metricName, targetValue, isMoney, area, deadline } = args as {
      title: string;
      metricName?: string;
      targetValue?: number;
      isMoney?: boolean;
      area?: string;
      deadline?: string;
    };

    let areaId: string | null = null;
    if (area) {
      const found = await prisma.lifeArea.findUnique({ where: { slug: area }, select: { id: true } });
      areaId = found?.id ?? null;
    }

    // Денежные цели хранятся в копейках, как и всё остальное в системе.
    // Модель оперирует рублями — переводим здесь, а не надеемся, что она
    // сама вспомнит про копейки.
    const stored =
      targetValue === undefined
        ? null
        : isMoney
          ? Math.round(targetValue * 100)
          : Math.round(targetValue);

    const goal = await prisma.goal.create({
      data: {
        title: title.trim(),
        metricName: metricName ?? null,
        targetValue: stored,
        isMoney: isMoney ?? false,
        areaId,
        deadline: deadline ? new Date(deadline) : null,
      },
      select: { id: true, title: true },
    });

    return { ok: true, message: `Цель создана: «${goal.title}».`, data: { goalId: goal.id } };
  },
};

export const listGoals: AgentTool = {
  name: "list_goals",
  description: "Показать активные цели владельца и прогресс по ним.",
  schema: z.object({}),
  async execute() {
    const goals = await prisma.goal.findMany({
      where: { status: "ACTIVE" },
      orderBy: [{ deadline: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      take: 20,
      include: { area: { select: { name: true } } },
    });

    if (goals.length === 0) return { ok: true, message: "Активных целей нет." };

    const lines = goals.map((g) => {
      const target =
        g.targetValue === null
          ? ""
          : g.isMoney
            ? ` — цель ${formatKop(g.targetValue)}`
            : ` — цель ${g.targetValue}${g.metricName ? " " + g.metricName : ""}`;
      const current =
        g.currentValue === null
          ? ""
          : g.isMoney
            ? `, сейчас ${formatKop(g.currentValue)}`
            : `, сейчас ${g.currentValue}`;
      const area = g.area ? ` [${g.area.name}]` : "";
      return `${g.title}${target}${current}${area} [id: ${g.id}]`;
    });

    return { ok: true, message: `Цели (${goals.length}):\n${lines.join("\n")}` };
  },
};
