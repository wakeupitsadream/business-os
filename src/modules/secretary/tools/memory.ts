import { z } from "zod";
import type { AgentTool } from "@/core/orchestrator";
import { recallFacts, saveFact } from "@/core/memory";

const CATEGORY = z
  .enum([
    "BUSINESS",
    "FINANCE",
    "HEALTH",
    "PSYCHOLOGY",
    "PREFERENCE",
    "GOAL",
    "RELATIONSHIP",
    "HISTORY",
  ])
  .describe("К чему относится факт");

export const saveMemoryFact: AgentTool = {
  name: "save_memory_fact",
  description:
    "Запомнить устойчивый факт о владельце — то, что пригодится и через месяц: " +
    "предпочтения, цели, обстоятельства, привычки. НЕ сохраняй разовые дела " +
    "(для них есть задачи) и то, что владелец сказал мимоходом о сегодняшнем дне.",
  schema: z.object({
    text: z
      .string()
      .min(3)
      .max(500)
      .describe("Факт одним предложением, от третьего лица: «Не любит звонки до полудня»"),
    category: CATEGORY.optional(),
    importance: z
      .number()
      .int()
      .min(1)
      .max(3)
      .optional()
      .describe("3 — попадает в контекст всегда. Ставь редко, только для главного"),
  }),
  // Личные заметки не должны попадать в журнал действий: он читается при
  // разборе инцидентов, и содержимому дневника там не место.
  sensitiveArgs: ["text"],
  async execute(args, ctx) {
    const { text, category, importance } = args as {
      text: string;
      category?: string;
      importance?: number;
    };

    const saved = await saveFact({
      text,
      category: category as never,
      importance,
      source: `run:${ctx.runId}`,
    });

    // Про отсутствие вектора владельцу знать незачем — факт сохранён и
    // найдётся. Но модели полезно: она не станет обещать «вспомню по смыслу».
    const note = saved.embedded ? "" : " (поиск по словам — векторный индекс недоступен)";
    return { ok: true, message: `Запомнила${note}.`, data: { factId: saved.id } };
  },
};

export const recallMemory: AgentTool = {
  name: "recall_memory",
  description:
    "Поискать в памяти то, что владелец рассказывал раньше. Вызывай на вопросы " +
    "«что я говорил про…», «помнишь, я…», а также когда для совета нужен контекст, " +
    "которого нет в текущем разговоре.",
  schema: z.object({
    query: z.string().min(2).max(300).describe("О чём вспомнить, своими словами"),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  async execute(args) {
    const { query, limit } = args as { query: string; limit?: number };

    const facts = await recallFacts(query, { limit });
    if (facts.length === 0) {
      return { ok: true, message: `Ничего не нашла по запросу «${query}».` };
    }

    const lines = facts.map((f) => `- ${f.text}`);
    return {
      ok: true,
      message: `Нашла (${facts.length}):\n${lines.join("\n")}`,
      data: { count: facts.length, via: facts[0]?.via },
    };
  },
};
