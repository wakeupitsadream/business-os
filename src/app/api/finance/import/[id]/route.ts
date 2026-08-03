import { NextResponse } from "next/server";
import { z } from "zod";
import { isAuthenticated } from "@/core/auth/session";
import { prisma } from "@/core/db";
import { logWarn } from "@/core/observability/logger";
import { ImportError, reparseBatch } from "@/modules/finance/import/batch";
import { commitBatch } from "@/modules/finance/import/commit";
import { cancelBatch, rollbackBatch } from "@/modules/finance/import/rollback";

/**
 * Действия над импортом: подтвердить, откатить, отменить.
 *
 * Всё через один роут с полем `action`, а не тремя вложенными: действий три,
 * они взаимоисключающие и делаются над одним объектом.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  action: z.enum(["commit", "rollback", "cancel", "reparse"]),
  fingerprint: z.string().max(64).optional(),
  acknowledgeWarnings: z.boolean().optional(),
  /** Счёт для повторного разбора, когда у партии его нет (упавший разбор). */
  accountId: z.string().max(40).optional(),
  decisions: z
    .array(
      z.object({
        index: z.number().int().min(0).max(50_000),
        include: z.boolean(),
        categoryId: z.string().max(40).nullable().optional(),
        projectId: z.string().max(40).nullable().optional(),
        mergeTransfer: z.boolean().optional(),
        // Решение владельца «это не вывод эквайринга, а настоящий доход».
        // Поле объявлено здесь, потому что Zod по умолчанию МОЛЧА выбрасывает
        // незаявленные ключи: интерфейс галочку рисовал и слал, коммит её
        // читал, а до коммита она не доезжала — и платёж клиента, в назначении
        // которого мелькнуло «ЮKassa», уходил переводом. Выручка пропадала из
        // месяца, виртуальный счёт уходил в минус, отменить можно было только
        // откатом всей партии.
        keepAsIncome: z.boolean().optional(),
      }),
    )
    .max(5_000)
    .optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  }

  const { id } = await params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Тело запроса не является JSON" }, { status: 400 });
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Проверь параметры запроса" }, { status: 400 });
  }
  const input = parsed.data;

  try {
    if (input.action === "cancel") {
      const cancelled = await cancelBatch(id);
      return NextResponse.json({ ok: cancelled });
    }

    if (input.action === "reparse") {
      // Разобрать заново из сохранённого файла: откат оставляет сырьё, но
      // достать его больше нечем. Возвращаем id НОВОЙ партии — старая остаётся
      // откатанной, чтобы история не переписывалась задним числом.
      const fresh = await reparseBatch(id, input.accountId);
      return NextResponse.json({ ok: true, batchId: fresh.id, stats: fresh.stats });
    }

    if (input.action === "rollback") {
      const result = await rollbackBatch(id);
      return NextResponse.json({ ok: true, ...result });
    }

    if (!input.fingerprint) {
      return NextResponse.json({ error: "Нет отпечатка предпросмотра" }, { status: 400 });
    }

    const result = await commitBatch({
      batchId: id,
      fingerprint: input.fingerprint,
      decisions: input.decisions ?? [],
      acknowledgeWarnings: input.acknowledgeWarnings,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof ImportError) {
      // Устаревший предпросмотр — конфликт, а не ошибка ввода: владельцу надо
      // перезагрузить страницу, а не править форму.
      const status = e.code === "stale" || e.code === "conflict" ? 409 : 400;
      return NextResponse.json({ error: e.message }, { status });
    }
    logWarn("finance.import_action_failed", {
      batchId: id,
      action: input.action,
      error: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ error: "Действие не удалось выполнить" }, { status: 500 });
  }
}

/** Предпросмотр батча: строки и итоги разбора. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  }

  const { id } = await params;
  const batch = await prisma.importBatch.findUnique({
    where: { id },
    select: {
      id: true,
      fileName: true,
      bankHint: true,
      status: true,
      error: true,
      parsedRows: true,
      stats: true,
      createdAt: true,
    },
  });

  if (!batch) return NextResponse.json({ error: "Импорт не найден" }, { status: 404 });
  return NextResponse.json({ ok: true, batch });
}
