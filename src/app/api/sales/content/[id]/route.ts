import { NextResponse } from "next/server";
import { z } from "zod";
import { isAuthenticated } from "@/core/auth/session";
import { logWarn } from "@/core/observability/logger";
import {
  ContentError,
  approvePost,
  editPost,
  rejectPost,
  reschedulePost,
  schedulePost,
  unschedulePost,
} from "@/modules/sales/content/actions";
import { resolveUncertain } from "@/modules/sales/content/publish";

/**
 * Действия над постом. Роут тонкий: все правила статусов живут в модуле —
 * второй путь их обошёл бы, а именно они не дают опубликовать пост дважды.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("action", [
  // День строкой, а не готовым инстантом: собранный в браузере, он считался бы
  // в поясе браузера, и пост на 00:30 уехал бы на соседние сутки.
  z.object({ action: z.literal("reschedule"), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.object({ action: z.literal("edit"), body: z.string().min(1).max(8000) }),
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("schedule"), at: z.string().datetime().optional() }),
  z.object({ action: z.literal("unschedule") }),
  z.object({ action: z.literal("reject") }),
  z.object({ action: z.literal("resolve"), decision: z.enum(["published", "reschedule"]) }),
]);

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

  try {
    switch (input.action) {
      case "reschedule": {
        const at = await reschedulePost(id, input.day);
        return NextResponse.json({ ok: true, scheduledAt: at.toISOString() });
      }
      case "edit":
        await editPost(id, input.body);
        return NextResponse.json({ ok: true });
      case "approve":
        await approvePost(id);
        return NextResponse.json({ ok: true });
      case "schedule": {
        const at = await schedulePost(id, input.at ? new Date(input.at) : undefined);
        return NextResponse.json({ ok: true, scheduledAt: at.toISOString() });
      }
      case "unschedule":
        await unschedulePost(id);
        return NextResponse.json({ ok: true });
      case "reject":
        await rejectPost(id);
        return NextResponse.json({ ok: true });
      case "resolve": {
        const done = await resolveUncertain(id, input.decision);
        if (!done) {
          return NextResponse.json({ error: "Статус поста уже изменился" }, { status: 409 });
        }
        return NextResponse.json({ ok: true });
      }
    }
  } catch (e) {
    if (e instanceof ContentError) {
      // «Уже опубликован» — конфликт: владельцу надо обновить страницу, а не
      // править форму. «Время прошло» — вопрос к нему, а не техошибка.
      const status = e.code === "notfound" ? 404 : e.code === "input" ? 422 : 409;
      return NextResponse.json({ error: e.message }, { status });
    }
    logWarn("sales.content_action_failed", {
      postId: id,
      action: input.action,
      error: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ error: "Действие не удалось выполнить" }, { status: 500 });
  }
}
