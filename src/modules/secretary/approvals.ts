import { prisma } from "@/core/db";
import { logInfo, logWarn } from "@/core/observability/logger";
import { secretaryRegistry } from "./agent";

/**
 * Исполнение отложенного действия после решения владельца.
 *
 * Один исполнитель на оба канала — веб-кнопку и кнопку в Telegram. Раньше
 * логика жила в веб-роуте, и чат был тупиком: агент говорил «действие ждёт
 * подтверждения», кнопок не присылал, а нажатие по ним некому было
 * обработать. Заявка, которую негде подтвердить, равна отказу — только
 * молчаливому.
 *
 * Правила, ради которых исполнитель один:
 *   1. повторное решение не исполняет действие второй раз;
 *   2. аргументы перед исполнением проходят схему инструмента заново —
 *      между подготовкой и подтверждением мог случиться деплой с другой
 *      схемой;
 *   3. сбой исполнения НЕ закрывает заявку: её можно нажать ещё раз, когда
 *      причина сбоя (обычно — база) пройдёт.
 */

export type ApprovalOutcome =
  | { status: "not_found"; message: string }
  | { status: "already"; message: string }
  | { status: "rejected"; message: string }
  | { status: "invalid"; message: string }
  | { status: "executed"; ok: boolean; message: string }
  | { status: "failed"; message: string };

export async function resolveApproval(
  notificationId: string,
  approved: boolean,
  channel: "WEB" | "TELEGRAM",
): Promise<ApprovalOutcome> {
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
    select: { id: true, type: true, payload: true, resolvedAt: true, resolution: true },
  });

  if (!notification || notification.type !== "APPROVAL_REQUIRED") {
    return { status: "not_found", message: "Запрос на подтверждение не найден." };
  }
  if (notification.resolvedAt) {
    // Повторное нажатие не должно выполнять действие второй раз.
    const was = notification.resolution === "APPROVED" ? "выполнено" : "отклонено";
    return { status: "already", message: `Это действие уже ${was}.` };
  }

  const payload = notification.payload as {
    actionId?: string;
    toolName?: string;
    args?: unknown;
  } | null;

  if (!approved) {
    await resolve(notification.id, payload?.actionId, "REJECTED");
    logInfo("approval.rejected", { toolName: payload?.toolName, channel });
    return { status: "rejected", message: "Отклонено. Действие не выполнено." };
  }

  const tool = payload?.toolName ? secretaryRegistry.get(payload.toolName) : undefined;
  if (!tool) {
    logWarn("approval.tool_missing", { toolName: payload?.toolName });
    await resolve(notification.id, payload?.actionId, "REJECTED");
    return {
      status: "invalid",
      message: `Инструмент «${payload?.toolName}» больше не существует — заявка закрыта.`,
    };
  }

  // Аргументы проверяем повторно: между подготовкой и подтверждением схема
  // инструмента могла измениться вместе с деплоем.
  const check = tool.schema.safeParse(payload?.args);
  if (!check.success) {
    await resolve(notification.id, payload?.actionId, "REJECTED");
    return {
      status: "invalid",
      message: "Сохранённые аргументы больше не подходят инструменту — заявка закрыта.",
    };
  }

  try {
    const result = await tool.execute(check.data, {
      runId: `approval:${notification.id}`,
      channel,
      now: new Date(),
    });
    await resolve(notification.id, payload?.actionId, "OK");
    logInfo("approval.executed", { toolName: payload?.toolName, ok: result.ok, channel });
    return { status: "executed", ok: result.ok, message: result.message };
  } catch (e) {
    // Заявку НЕ закрываем: сбой исполнения — не решение владельца. Кнопка
    // остаётся живой, повторное нажатие попробует снова.
    const message = e instanceof Error ? e.message : String(e);
    logWarn("approval.execute_failed", { toolName: payload?.toolName, error: message });
    return { status: "failed", message: `Не удалось выполнить: ${message}` };
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
