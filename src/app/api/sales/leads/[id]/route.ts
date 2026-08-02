import { NextResponse } from "next/server";
import { isAuthenticated } from "@/core/auth/session";
import { logWarn } from "@/core/observability/logger";
import { loadLeadCard } from "@/modules/sales/lead-card";

/**
 * Карточка лида для выдвижной панели канбана.
 *
 * Отдельный роут, а не серверный компонент: панель открывается по клику на
 * карточке, и грузить ради неё страницу целиком значит терять состояние доски
 * (прокрутку колонок, начатый перенос) на каждый просмотр лида.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  }

  const { id } = await params;
  try {
    const card = await loadLeadCard(id);
    if (!card) return NextResponse.json({ error: "Лид не найден" }, { status: 404 });
    return NextResponse.json(card);
  } catch (e) {
    logWarn("sales.lead_card_failed", {
      leadId: id,
      error: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ error: "Не удалось загрузить карточку" }, { status: 500 });
  }
}
