import { NextResponse } from "next/server";
import { isAuthenticated } from "@/core/auth/session";
import { LlmUnavailableError, llmChat, llmConfigured, resolveVariants } from "@/core/llm";
import { logError } from "@/core/observability/logger";

/**
 * Диагностика LLM-каскада: живой вызов через реальные шлюзы.
 *
 * Нужен, чтобы после выкатки за десять секунд понять, работает ли связка
 * ключ → шлюз → модель, не гоняя для этого секретаря в Telegram. Отвечает,
 * КАКОЙ шлюз и КАКАЯ модель обслужили запрос — при каскаде это главный вопрос:
 * ответ пришёл, но пришёл ли он с основного шлюза или уже с резервного.
 *
 * Закрыт сессией владельца: вызов стоит денег.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  }

  // Порядок вариантов показываем всегда — даже когда вызов не удался, видно,
  // что именно система собиралась пробовать и в какой последовательности.
  const variants = resolveVariants("cheap").map((v) => `${v.gateway.id}:${v.model}`);

  if (!llmConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error: "Ни один LLM-шлюз не настроен: задайте POLZA_API_KEY или PROXYAPI_API_KEY",
        variants,
      },
      { status: 503 },
    );
  }

  try {
    const result = await llmChat({
      feature: "dev.ping",
      preset: "cheap",
      maxTokens: 32,
      messages: [
        {
          role: "user",
          content: "Ответь ровно одним словом: понг",
        },
      ],
    });

    return NextResponse.json({
      ok: true,
      reply: result.text,
      gateway: result.gateway,
      model: result.model,
      latencyMs: result.latencyMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      variants,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "неизвестная ошибка";
    logError("llm.ping_failed", { error: message });

    // 503, а не 500: шлюзы недоступны — это состояние внешней зависимости,
    // а не поломка приложения. По коду ответа сразу видно, куда смотреть.
    return NextResponse.json(
      {
        ok: false,
        error: message,
        exhausted: e instanceof LlmUnavailableError,
        variants,
      },
      { status: 503 },
    );
  }
}
