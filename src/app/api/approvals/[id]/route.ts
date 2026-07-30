import { NextResponse } from "next/server";
import { prisma } from "@/core/db";
import { isAuthenticated } from "@/core/auth/session";
import { logInfo, logWarn } from "@/core/observability/logger";
import { secretaryRegistry } from "@/modules/secretary/agent";

/**
 * Подтверждение или отклонение отложенного действия агента.
 *
 * Без этого роута защита опасных инструментов была бы половинчатой: агент
 * готовит действие, создаёт уведомление — и подтвердить его негде, то есть
 * действие не выполняется никогда. Механизм подтверждения имеет смысл только
 * вместе со способом подтвердить.
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

  const notification = await prisma.notification.findUnique({
    where: { id },
    select: { id: true, type: true, payload: true, resolvedAt: true, title: true },
  });

  if (!notification || notification.type !== "APPROVAL_REQUIRED") {
    return NextResponse.json({ error: "Запрос на подтверждение не найден" }, { status: 404 });
  }
  if (notification.resolvedAt) {
    // Повторное нажатие не должно выполнять действие второй раз.
    return NextResponse.json({ ok: true, alreadyResolved: true });
  }

  const payload = notification.payload as {
    actionId?: string;
    toolName?: string;
    args?: unknown;
  } | null;

  if (!approved) {
    await resolve(notification.id, payload?.actionId, "REJECTED");
    logInfo("approval.rejected", { toolName: payload?.toolName });
    return NextResponse.json({ ok: true, executed: false });
  }

  const tool = payload?.toolName ? secretaryRegistry.get(payload.toolName) : undefined;
  if (!tool) {
    logWarn("approval.tool_missing", { toolName: payload?.toolName });
    await resolve(notification.id, payload?.actionId, "REJECTED");
    return NextResponse.json(
      { error: `Инструмент «${payload?.toolName}» больше не существует` },
      { status: 409 },
    );
  }

  // Аргументы проверяем повторно: между подготовкой и подтверждением схема
  // инструмента могла измениться вместе с деплоем.
  const check = tool.schema.safeParse(payload?.args);
  if (!check.success) {
    await resolve(notification.id, payload?.actionId, "REJECTED");
    return NextResponse.json(
      { error: "Сохранённые аргументы больше не подходят инструменту" },
      { status: 409 },
    );
  }

  try {
    const result = await tool.execute(check.data, {
      runId: `approval:${notification.id}`,
      channel: "WEB",
      now: new Date(),
    });
    await resolve(notification.id, payload?.actionId, "OK");
    logInfo("approval.executed", { toolName: payload?.toolName, ok: result.ok });
    return NextResponse.json({ ok: result.ok, executed: true, message: result.message });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logWarn("approval.execute_failed", { toolName: payload?.toolName, error: message });
    return NextResponse.json({ error: `Не удалось выполнить: ${message}` }, { status: 500 });
  }
}

async function resolve(
  notificationId: string,
  actionId: string | undefined,
  actionStatus: "OK" | "REJECTED",
): Promise<void> {
  await prisma.notification.update({
    where: { id: notificationId },
    data: {
      resolvedAt: new Date(),
      resolution: actionStatus === "OK" ? "APPROVED" : "REJECTED",
      readAt: new Date(),
    },
  });
  if (actionId) {
    await prisma.agentAction.updateMany({
      where: { id: actionId },
      data: { status: actionStatus },
    });
  }
}
