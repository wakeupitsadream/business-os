import { NextResponse } from "next/server";
import { z } from "zod";
import { isAuthenticated } from "@/core/auth/session";
import { logWarn } from "@/core/observability/logger";
import { approveDraft, markReplied, markSent, rejectDraft } from "@/modules/sales/outreach/actions";
import { PipelineError } from "@/modules/sales/pipeline";

/**
 * Действия над черновиком аутрича.
 *
 * Действия «отправить» здесь нет и не будет: система ничего не отправляет.
 * `sent` означает «я это уже написал руками» — она только записывает касание,
 * двигает воронку и ставит напоминание вернуться через три дня.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  action: z.enum(["approve", "reject", "sent", "replied"]),
  /** Текст владельца вместо предложенного. Сохраняется рядом с оригиналом. */
  editedBody: z.string().max(2000).optional(),
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
    switch (parsed.data.action) {
      case "approve":
        return NextResponse.json({ changed: await approveDraft(id, parsed.data.editedBody) });
      case "reject":
        return NextResponse.json({ changed: await rejectDraft(id) });
      case "replied":
        return NextResponse.json({ changed: await markReplied(id) });
      case "sent": {
        // Правка могла прийти вместе с отметкой: владелец поменял текст прямо
        // перед отправкой и не нажимал «одобрить» отдельно.
        if (parsed.data.editedBody) await approveDraft(id, parsed.data.editedBody);
        return NextResponse.json(await markSent(id));
      }
    }
  } catch (e) {
    if (e instanceof PipelineError) {
      const status = e.code === "not_found" ? 404 : e.code === "input" ? 422 : 409;
      return NextResponse.json({ error: e.message }, { status });
    }
    logWarn("sales.outreach_action_failed", {
      draftId: id,
      error: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ error: "Действие не удалось выполнить" }, { status: 500 });
  }
}
