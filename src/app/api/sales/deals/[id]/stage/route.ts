import { NextResponse } from "next/server";
import { z } from "zod";
import { isAuthenticated } from "@/core/auth/session";
import { logWarn } from "@/core/observability/logger";
import { PipelineError, moveDeal } from "@/modules/sales/pipeline";

/**
 * Перенос сделки на другую стадию — то, что делает drag-n-drop на канбане.
 *
 * Роут тонкий намеренно: все правила (обязательная причина проигрыша, запись
 * касания, время на стадии) живут в `moveDeal`. Второй путь смены стадии —
 * прямой `prisma.deal.update` из компонента — обошёл бы их все разом, и
 * воронка перестала бы отвечать на вопрос «почему не покупают».
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  toStageId: z.string().min(1).max(40),
  lostReason: z
    .enum(["PRICE", "NO_NEED", "COMPETITOR", "NO_ANSWER", "BAD_TIMING", "OTHER"])
    .optional(),
  note: z.string().max(500).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  }

  const { id } = await params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Неверные параметры" }, { status: 400 });
  }

  try {
    const result = await moveDeal({
      dealId: id,
      toStageId: parsed.data.toStageId,
      lostReason: parsed.data.lostReason ?? null,
      note: parsed.data.note ?? null,
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof PipelineError) {
      // Причина проигрыша — не техническая ошибка, а вопрос владельцу.
      // 422 отличает её от «сделки нет» (404) и от битого запроса (400).
      const status = e.code === "not_found" ? 404 : e.code === "input" ? 422 : 409;
      return NextResponse.json({ error: e.message }, { status });
    }
    logWarn("sales.stage_change_failed", {
      dealId: id,
      error: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ error: "Действие не удалось выполнить" }, { status: 500 });
  }
}
