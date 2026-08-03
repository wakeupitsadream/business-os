import { NextResponse } from "next/server";
import { z } from "zod";
import { isAuthenticated } from "@/core/auth/session";
import { logWarn } from "@/core/observability/logger";
import { addTouchPoint, scheduleFollowUp } from "@/modules/sales/leads";
import { PipelineError } from "@/modules/sales/pipeline";

/**
 * Записать касание и, если владелец назвал срок, сразу поставить следующее.
 *
 * Одним запросом намеренно: «позвонил, перезвонить в четверг» — одно действие
 * в голове владельца. Разложенное на две формы, оно на второй забывается, и
 * воронка снова держится на памяти, а не на базе.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  // STAGE_CHANGE в списке нет: смену стадии пишет только `moveDeal`, вместе с
  // самой сменой. Иначе в ленте появляются переходы, которых не было.
  kind: z.enum(["NOTE", "CALL", "MESSAGE_TG", "MESSAGE_WA", "EMAIL", "MEETING"]),
  body: z.string().max(2000).optional(),
  dealId: z.string().min(1).max(40).optional(),
  /** ISO-время следующего касания. Необязательно. */
  followUpAt: z.string().datetime({ offset: true }).optional(),
  followUpNote: z.string().max(500).optional(),
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
  const input = parsed.data;

  const dueAt = input.followUpAt ? new Date(input.followUpAt) : null;
  if (dueAt && Number.isNaN(dueAt.getTime())) {
    return NextResponse.json({ error: "Не разобрали срок следующего касания" }, { status: 400 });
  }

  try {
    const touch = await addTouchPoint({
      leadId: id,
      dealId: input.dealId ?? null,
      kind: input.kind,
      body: input.body ?? null,
    });

    const followUp = dueAt
      ? await scheduleFollowUp({
          leadId: id,
          dealId: input.dealId ?? null,
          dueAt,
          note: input.followUpNote ?? null,
          origin: "MANUAL",
        })
      : null;

    return NextResponse.json({
      touchPointId: touch.touchPointId,
      followUpId: followUp?.followUpId ?? null,
    });
  } catch (e) {
    if (e instanceof PipelineError) {
      const status = e.code === "not_found" ? 404 : e.code === "input" ? 422 : 409;
      return NextResponse.json({ error: e.message }, { status });
    }
    // Несуществующий лид ловится внешним ключом, а не проверкой: гонка между
    // проверкой и записью всё равно оставила бы этот путь.
    logWarn("sales.touch_failed", {
      leadId: id,
      error: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ error: "Касание не записано" }, { status: 500 });
  }
}
