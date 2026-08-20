import { NextResponse } from "next/server";
import { isAuthenticated } from "@/core/auth/session";
import { resolveApproval } from "@/modules/secretary/approvals";

/**
 * Подтверждение или отклонение отложенного действия агента — веб-кнопка.
 *
 * Сама логика (идемпотентность, повторная проверка схемы, исполнение) живёт в
 * modules/secretary/approvals и одна на оба канала: этот роут и кнопки в
 * Telegram. Здесь — только авторизация и перевод исхода в HTTP.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  }

  const { id } = await params;
  const url = new URL(request.url);
  const approved = url.searchParams.get("decision") !== "reject";

  const outcome = await resolveApproval(id, approved, "WEB");

  switch (outcome.status) {
    case "not_found":
      return NextResponse.json({ error: outcome.message }, { status: 404 });
    case "already":
      return NextResponse.json({ ok: true, alreadyResolved: true });
    case "rejected":
      return NextResponse.json({ ok: true, executed: false });
    case "invalid":
      return NextResponse.json({ error: outcome.message }, { status: 409 });
    case "executed":
      return NextResponse.json({ ok: outcome.ok, executed: true, message: outcome.message });
    case "failed":
      return NextResponse.json({ error: outcome.message }, { status: 500 });
  }
}
