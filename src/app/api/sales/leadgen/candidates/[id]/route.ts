import { NextResponse } from "next/server";
import { z } from "zod";
import { isAuthenticated } from "@/core/auth/session";
import { logWarn } from "@/core/observability/logger";
import { importCandidate, skipCandidate } from "@/modules/sales/leadgen/import";
import { PipelineError } from "@/modules/sales/pipeline";

/**
 * Решение владельца по кандидату: в CRM или мимо.
 *
 * Ответ `needs_confirmation` — не ошибка, а вопрос: нашлись лиды с похожим
 * названием, и третий уровень дедупа их не склеивает сам. Поэтому 200 с
 * телом, а не 409: клиенту надо показать список и спросить, а не сообщить о
 * сбое.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  action: z.enum(["import", "skip"]),
  /** Ответ на третий уровень: «это тот же лид». */
  mergeIntoLeadId: z.string().min(1).max(40).optional(),
  /** Ответ на третий уровень: «нет, другая компания». */
  asNewLead: z.boolean().optional(),
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
    if (parsed.data.action === "skip") {
      return NextResponse.json({ outcome: (await skipCandidate(id)) ? "skipped" : "already" });
    }

    const result = await importCandidate(id, {
      mergeIntoLeadId: parsed.data.mergeIntoLeadId,
      asNewLead: parsed.data.asNewLead,
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof PipelineError) {
      const status = e.code === "not_found" ? 404 : e.code === "input" ? 422 : 409;
      return NextResponse.json({ error: e.message }, { status });
    }
    logWarn("sales.candidate_action_failed", {
      candidateId: id,
      error: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ error: "Действие не удалось выполнить" }, { status: 500 });
  }
}
