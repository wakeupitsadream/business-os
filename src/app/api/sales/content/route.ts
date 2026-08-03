import { NextResponse } from "next/server";
import { isAuthenticated } from "@/core/auth/session";
import { logWarn } from "@/core/observability/logger";
import { buildWeeklyPlan } from "@/modules/sales/content/plan";

/** Кнопка «собрать план недели». Идемпотентна по ключу недели. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  }

  try {
    const res = await buildWeeklyPlan();
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    logWarn("sales.content_plan_failed", { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ error: "Не удалось собрать план" }, { status: 500 });
  }
}
