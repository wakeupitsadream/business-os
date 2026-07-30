import { NextResponse } from "next/server";
import { isAuthenticated } from "@/core/auth/session";
import { logWarn } from "@/core/observability/logger";
import { createAndParseBatch, ImportError, MAX_FILE_BYTES } from "@/modules/finance/import/batch";
import { StatementParseError } from "@/modules/finance/import/types";
import { prisma } from "@/core/db";

/**
 * Загрузка выписки.
 *
 * Файл приходит СЫРЫМИ БАЙТАМИ в теле, а не через multipart. Причина
 * практическая: `request.formData()` буферизует тело целиком до того, как его
 * можно измерить, — то есть заливка на полгигабайта съест память раньше, чем
 * сработает проверка на 10 МБ. Рамочного лимита у route handler'ов нет
 * (`bodySizeLimit` в next.config относится только к server actions), поэтому
 * лимит держим сами и считаем байты по мере чтения.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  }

  const url = new URL(request.url);
  const accountId = (url.searchParams.get("accountId") ?? "").trim();
  const fileName = (url.searchParams.get("fileName") ?? "выписка.csv").slice(0, 200);

  if (accountId === "") {
    return NextResponse.json({ error: "Не выбран счёт" }, { status: 400 });
  }

  let bytes: Uint8Array;
  try {
    bytes = await readLimited(request, MAX_FILE_BYTES);
  } catch (e) {
    if (e instanceof TooLargeError) {
      return NextResponse.json(
        { error: `Файл больше ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} МБ` },
        { status: 413 },
      );
    }
    return NextResponse.json({ error: "Не удалось прочитать файл" }, { status: 400 });
  }

  try {
    const result = await createAndParseBatch({ fileName, bytes, accountId });
    return NextResponse.json({ ok: true, id: result.id, status: result.status, stats: result.stats });
  } catch (e) {
    if (e instanceof StatementParseError || e instanceof ImportError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    logWarn("finance.import_upload_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ error: "Не удалось обработать выписку" }, { status: 500 });
  }
}

/** История импортов — для страницы и для отката. */
export async function GET(): Promise<NextResponse> {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  }

  const batches = await prisma.importBatch.findMany({
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      fileName: true,
      bankHint: true,
      status: true,
      error: true,
      createdAt: true,
      committedAt: true,
      _count: { select: { transactions: true } },
    },
  });

  return NextResponse.json({ ok: true, batches });
}

class TooLargeError extends Error {}

/**
 * Чтение тела со счётчиком.
 *
 * Content-Length проверяется первым как быстрый отказ, но верить ему нельзя:
 * заголовок пишет клиент. Поэтому байты считаются и при чтении, и поток
 * обрывается на превышении, а не после.
 */
async function readLimited(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw new TooLargeError();

  const body = request.body;
  if (!body) throw new Error("пустое тело");

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new TooLargeError();
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
