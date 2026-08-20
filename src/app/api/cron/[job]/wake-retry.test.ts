import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Повтор джобы после «база просыпается».
 *
 * Спящий компьют Neon просыпается по первому запросу и не всегда успевает в
 * таймаут подключения. До повтора каждый такой случай выглядел как «Задача
 * упала: Can't reach database server» — тревога владельцу при исправной базе.
 */

const handler = vi.fn(async (..._a: unknown[]) => ({ ok: true, detail: "ок" }));
vi.mock("@/core/cron/registry", () => ({
  getCronHandler: (name: string) => (name === "test-job" ? () => handler() : undefined),
}));

const alertOwner = vi.fn(async (..._a: unknown[]) => {});
vi.mock("@/core/observability/alerts", () => ({
  alertOwner: (...a: unknown[]) => alertOwner(...a),
}));

const { POST } = await import("./route");

const WAKE = "\nInvalid `prisma.parseJob.findMany()` invocation:\n\nCan't reach database server at `ep-x-pooler.eu-central-1.aws.neon.tech:5432`";

function request(): NextRequest {
  return new NextRequest("https://app.example.com/api/cron/test-job", {
    method: "POST",
    headers: { authorization: "Bearer s3cret" },
  });
}

const params = { params: Promise.resolve({ job: "test-job" }) };

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "s3cret");
  handler.mockReset();
  alertOwner.mockClear();
  handler.mockResolvedValue({ ok: true, detail: "ок" });
});

describe("пробуждение базы", () => {
  it("один провал на «Can't reach» → пауза, повтор, тихий успех", async () => {
    handler.mockRejectedValueOnce(new Error(WAKE));

    const res = await POST(request(), params);

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(alertOwner).not.toHaveBeenCalled();
  });

  it("повтор ровно один: вторая неудача — честная тревога", async () => {
    handler.mockRejectedValue(new Error(WAKE));

    const res = await POST(request(), params);

    expect(res.status).toBe(500);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(alertOwner).toHaveBeenCalledTimes(1);
  });

  it("не-сетевая ошибка не повторяется: повтор мог бы задвоить работу зря", async () => {
    handler.mockRejectedValue(new Error("unique constraint failed"));

    const res = await POST(request(), params);

    expect(res.status).toBe(500);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
