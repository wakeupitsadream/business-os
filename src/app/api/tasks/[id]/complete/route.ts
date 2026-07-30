import { NextResponse } from "next/server";
import { prisma } from "@/core/db";
import { isAuthenticated } from "@/core/auth/session";

/**
 * Отметить задачу выполненной из интерфейса.
 *
 * Тот же эффект, что у инструмента complete_task, — и это намеренно один и тот
 * же результат в базе: задача, закрытая на экране, должна исчезнуть из ответа
 * секретаря в Telegram, иначе владелец получит два расходящихся списка дел.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  }

  const { id } = await params;

  const updated = await prisma.task.updateMany({
    where: { id, status: { in: ["TODO", "IN_PROGRESS"] } },
    data: { status: "DONE", completedAt: new Date() },
  });

  if (updated.count === 0) {
    // Либо задачи нет, либо она уже закрыта. Второе — не ошибка: интерфейс мог
    // отправить повтор, и падать на этом незачем.
    const exists = await prisma.task.findUnique({ where: { id }, select: { status: true } });
    if (!exists) return NextResponse.json({ error: "Задача не найдена" }, { status: 404 });
    return NextResponse.json({ ok: true, alreadyDone: true });
  }

  return NextResponse.json({ ok: true });
}
