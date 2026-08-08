import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Health-чеки продуктов.
 *
 * Наши health-роуты всегда отвечают 200 (иначе хостинг откатывает деплой),
 * а настоящее состояние кладут в тело. Проба обязана читать `ok` из JSON —
 * иначе панель показывала бы зелёное при лежащей базе.
 */

const { probeHealth } = await import("./health");

const CHECK = { name: "ОС", url: "https://os.example/api/health" };

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("проба здоровья", () => {
  it("200 с ok:true — здоров, задержка измерена", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const res = await probeHealth(CHECK);
    expect(res.ok).toBe(true);
    expect(res.latencyMs).not.toBeNull();
  });

  it("200 с ok:false — НЕ здоров: статус врёт, тело говорит правду", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, checks: {} }));
    const res = await probeHealth(CHECK);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("ok: false");
  });

  it("не-JSON с кодом 200 — здоров: смотреть больше не на что", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    const res = await probeHealth(CHECK);
    expect(res.ok).toBe(true);
  });

  it("HTTP 500 — не здоров", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    const res = await probeHealth(CHECK);
    expect(res.ok).toBe(false);
    expect(res.detail).toBe("HTTP 500");
  });

  it("таймаут — не здоров, задержки нет", async () => {
    const timeoutError = new DOMException("The operation timed out.", "TimeoutError");
    fetchMock.mockRejectedValue(timeoutError);
    const res = await probeHealth(CHECK);
    expect(res.ok).toBe(false);
    expect(res.latencyMs).toBeNull();
    expect(res.detail).toContain("5 секунд");
  });

  it("обрыв сети — не здоров, без деталей транспорта в тексте", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed: ENOTFOUND os.example"));
    const res = await probeHealth(CHECK);
    expect(res.ok).toBe(false);
    expect(res.detail).toBe("нет соединения");
  });

  it("битый JSON при 200 не объявляет сервис лежащим", async () => {
    fetchMock.mockResolvedValue(
      new Response("{оборвалось", { status: 200, headers: { "content-type": "application/json" } }),
    );
    const res = await probeHealth(CHECK);
    expect(res.ok).toBe(true);
  });
});
