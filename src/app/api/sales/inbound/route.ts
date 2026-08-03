import { NextResponse } from "next/server";
import { z } from "zod";
import { secretsMatch, bearerToken } from "@/core/auth/bearer";
import { clientIp } from "@/core/auth/rate-limit";
import { optionalEnv } from "@/core/env";
import { logError, logWarn } from "@/core/observability/logger";
import { acceptInboundLead } from "@/modules/sales/inbound";
import { hitInboundQuota } from "@/modules/sales/inbound-quota";

/**
 * Приём заявок с agentus.space.
 *
 * Первый роут системы, который пишет в базу по инициативе ЧУЖОГО сервиса.
 * Отсюда всё, что ниже.
 *
 * **Авторизация — свой секрет, не `CRON_SECRET`.** Соблазн переиспользовать
 * был, но секрет кронов даёт право запускать любые фоновые задачи, и класть
 * его в чужое приложение значит расширять радиус поражения с «поток мусорных
 * заявок» до «дёргай что хочешь». `SALES_INBOUND_SECRET` умеет ровно одно.
 *
 * **Секрет не задан — роут выключен (503), а не открыт.** Забытая переменная
 * окружения не должна бесшумно превращаться в публичную форму записи в базу.
 *
 * **Лимит частоты поверх секрета.** Секрет живёт в чужом приложении и в его
 * логах; когда-нибудь он утечёт. Лимит превращает утечку из «залили тысячу
 * заявок» в «залили немного и упёрлись».
 *
 * **Коды ответа выбраны под РЕТРАЙ Agentus.** 200 — приняли (в том числе
 * повтор уже принятой заявки); 401/400 — не ретраить, тут ничего не изменится;
 * 429 и 503 — ретраить позже. Заявка, потерянная из-за нашей пятисотки, — это
 * человек, который заполнил форму и не дождался ответа.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  externalId: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(200),
  phone: z.string().max(50).optional(),
  email: z.string().max(200).optional(),
  city: z.string().max(120).optional(),
  site: z.string().max(300).optional(),
  message: z.string().max(4000).optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const expected = optionalEnv("SALES_INBOUND_SECRET");
  if (!expected) {
    // Выключено, а не открыто. 503 честно говорит Agentus «попробуй позже»:
    // владелец задаст переменную, и накопленные ретраи доедут.
    logError("sales.inbound_secret_missing", {});
    return NextResponse.json(
      { error: "Приём заявок не настроен" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  if (!secretsMatch(bearerToken(request), expected)) {
    logWarn("sales.inbound_unauthorized", { ip: clientIp(request.headers) });
    return NextResponse.json({ error: "Неверный секрет" }, { status: 401 });
  }

  const quota = hitInboundQuota(clientIp(request.headers));
  if (!quota.allowed) {
    return NextResponse.json(
      { error: "Слишком много заявок, попробуйте позже" },
      { status: 429, headers: { "retry-after": String(quota.retryAfterSec) } },
    );
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    // 400, а не 422: ретраить тот же битый payload незачем.
    logWarn("sales.inbound_bad_payload", { issue: parsed.error?.issues[0]?.path.join(".") });
    return NextResponse.json({ error: "Неверный формат заявки" }, { status: 400 });
  }

  try {
    const result = await acceptInboundLead(parsed.data);
    return NextResponse.json(result, { status: 200, headers: { "cache-control": "no-store" } });
  } catch (e) {
    // Сюда попадает только отказ базы: черновик и пуш свои ошибки глотают
    // сами. 503 — приглашение повторить, и повтор безопасен: дедуп по
    // externalId и по телефону не даст завести лида дважды.
    logError("sales.inbound_failed", { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ error: "Не удалось принять заявку" }, { status: 503 });
  }
}
