import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/core/db";
import { isAuthenticated } from "@/core/auth/session";
import { LlmUnavailableError } from "@/core/llm";
import { runAgent } from "@/core/orchestrator";
import { logError } from "@/core/observability/logger";
import { secretaryAgent } from "@/modules/secretary/agent";

/**
 * Чат с секретарём из веба.
 *
 * Тот же агент и тот же диалог, что в Telegram: владелец начинает разговор с
 * телефона и продолжает за столом. Разные истории для разных экранов означали
 * бы, что секретарь «забывает» сказанное час назад, — а память тут и есть
 * главная ценность.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  text: z.string().min(1).max(4000),
});

export async function POST(request: Request): Promise<NextResponse> {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  }

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Пустой или слишком длинный запрос" }, { status: 400 });
  }

  const text = parsed.text.trim();

  try {
    const conversation = await getWebConversation();

    // Сообщение владельца сохраняем ДО запуска агента: если генерация упадёт,
    // вопрос останется в истории и не потеряется.
    await prisma.message.create({
      data: { conversationId: conversation.id, role: "USER", content: text },
    });

    const result = await runAgent(secretaryAgent, {
      agentKey: secretaryAgent.key,
      conversationId: conversation.id,
      channel: "WEB",
      trigger: "CHAT",
      userText: text,
    });

    const reply = result.text.trim() || "Не нашлась с ответом — переформулируй, пожалуйста.";
    await prisma.message.create({
      data: { conversationId: conversation.id, role: "ASSISTANT", content: reply },
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });

    return NextResponse.json({
      reply,
      toolCalls: result.toolCallCount,
      pendingApprovals: result.pendingApprovals,
    });
  } catch (e) {
    // Текст LlmUnavailableError уже написан для владельца и объясняет причину.
    const message =
      e instanceof LlmUnavailableError
        ? e.message
        : "Не получилось ответить. Загляни в логи — там причина.";
    logError("chat.failed", { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

/** История веб-чата. Один активный тред — как и в Telegram. */
async function getWebConversation() {
  const existing = await prisma.conversation.findFirst({
    where: { agentKey: "secretary", channel: "WEB", archived: false },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (existing) return existing;

  return prisma.conversation.create({
    data: { agentKey: "secretary", channel: "WEB", title: "Секретарь" },
    select: { id: true },
  });
}
