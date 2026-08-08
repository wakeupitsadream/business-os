import type { HealthCheck } from "./config";

/**
 * Health-чеки продуктов.
 *
 * Проба смотрит на HTTP-статус, а если сервис ответил JSON-ом с булевым `ok` —
 * ещё и на него: наш собственный `/api/health` (и health Agentus) всегда
 * отвечает 200, чтобы не ломать деплой, а настоящее состояние кладёт в тело.
 * Проба, верящая одному статусу, показывала бы зелёное при лежащей базе.
 */

/** Дольше пяти секунд для health-роута — это уже само по себе диагноз. */
const TIMEOUT_MS = 5_000;

export interface HealthResult {
  name: string;
  url: string;
  ok: boolean;
  /** null — ответа не было (таймаут или сеть). */
  latencyMs: number | null;
  detail: string;
}

export async function probeHealth(check: HealthCheck): Promise<HealthResult> {
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(check.url, {
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json, text/html;q=0.5" },
    });
  } catch (e) {
    const timeout = e instanceof Error && e.name === "TimeoutError";
    return {
      name: check.name,
      url: check.url,
      ok: false,
      latencyMs: null,
      detail: timeout ? "не ответил за 5 секунд" : "нет соединения",
    };
  }

  const latencyMs = Date.now() - startedAt;

  if (!res.ok) {
    res.body?.cancel().catch(() => undefined);
    return { name: check.name, url: check.url, ok: false, latencyMs, detail: `HTTP ${res.status}` };
  }

  if ((res.headers.get("content-type") ?? "").includes("json")) {
    try {
      const body: unknown = await res.json();
      if (
        typeof body === "object" &&
        body !== null &&
        "ok" in body &&
        (body as { ok: unknown }).ok === false
      ) {
        return {
          name: check.name,
          url: check.url,
          ok: false,
          latencyMs,
          detail: "отвечает, но сообщает о поломке (ok: false)",
        };
      }
    } catch {
      // Битый JSON при 200 — не повод объявлять сервис лежащим: статус важнее.
    }
  } else {
    res.body?.cancel().catch(() => undefined);
  }

  return { name: check.name, url: check.url, ok: true, latencyMs, detail: `HTTP ${res.status}` };
}
