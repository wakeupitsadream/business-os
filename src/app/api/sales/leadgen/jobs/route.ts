import { NextResponse } from "next/server";
import { z } from "zod";
import { isAuthenticated } from "@/core/auth/session";
import { logWarn } from "@/core/observability/logger";
import { createParseJob, listParseJobs } from "@/modules/sales/leadgen/jobs";
import { PipelineError } from "@/modules/sales/pipeline";

/**
 * Прогоны лидогена: посмотреть и завести.
 *
 * Запускать прогон немедленно роут не умеет намеренно. Город не помещается ни
 * в одну выдачу и почти наверняка не помещается в суточный кап — работа идёт
 * тиками крона часами, и «кнопка запуска», после которой ничего не происходит
 * за время просмотра страницы, обманывала бы ожидание. Джоба ставится в
 * очередь, а её движение видно в списке.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  connector: z.enum(["yandex_geo", "two_gis", "stub"]),
  rubric: z.string().min(2).max(100),
  city: z.string().min(2).max(100),
  niche: z.enum(["AUTO_SERVICE", "PRIVATE_MASTER", "OTHER"]).optional(),
});

export async function GET(): Promise<NextResponse> {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  }

  try {
    return NextResponse.json({ jobs: await listParseJobs() });
  } catch (e) {
    logWarn("sales.parse_jobs_list_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ error: "Не удалось получить список" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Неверные параметры" }, { status: 400 });
  }

  try {
    const result = await createParseJob(parsed.data);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof PipelineError) {
      const status = e.code === "not_found" ? 404 : e.code === "input" ? 422 : 409;
      return NextResponse.json({ error: e.message }, { status });
    }
    logWarn("sales.parse_job_create_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ error: "Прогон не создан" }, { status: 500 });
  }
}
