import { NextResponse } from "next/server";
import { z } from "zod";
import { isAuthenticated } from "@/core/auth/session";
import { logWarn } from "@/core/observability/logger";
import { completeFollowUp } from "@/modules/sales/leads";

/**
 * Закрыть запланированное касание — «сделал» или «не буду».
 *
 * Пропуск фиксируется отдельным статусом, а не удалением: касание, которое
 * владелец сознательно пропустил, и касание, до которого не дошли руки, — это
 * разные вещи, и различать их надо в тот момент, когда решение принимается.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ status: z.enum(["DONE", "SKIPPED"]).default("DONE") });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  }

  const { id } = await params;
  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Неверные параметры" }, { status: 400 });
  }

  try {
    const done = await completeFollowUp(id, parsed.data.status);
    if (!done) {
      // Уже закрыто или не существует — для владельца это одно и то же:
      // повторный клик по кнопке в открытой панели не должен пугать ошибкой.
      return NextResponse.json({ changed: false });
    }
    return NextResponse.json({ changed: true });
  } catch (e) {
    logWarn("sales.follow_up_complete_failed", {
      followUpId: id,
      error: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ error: "Не удалось закрыть касание" }, { status: 500 });
  }
}
