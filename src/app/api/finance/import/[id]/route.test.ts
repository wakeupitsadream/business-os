import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Роут подтверждения импорта: решения владельца должны доезжать до коммита.
 *
 * Тест идёт ЧЕРЕЗ роут, а не через `commitBatch` напрямую, и это принципиально.
 * Сломано было ровно здесь: интерфейс рисовал галочку «это настоящий доход» и
 * слал `keepAsIncome`, коммит её читал, а Zod-схема роута поле не объявляла —
 * и молча выбрасывала, потому что по умолчанию Zod срезает незаявленные ключи.
 * Обе стороны выглядели исправными, тесты обеих сторон проходили, а платёж
 * клиента, в назначении которого мелькнуло «ЮKassa», всё равно уходил
 * переводом: выручка пропадала из месяца.
 */

const authenticated = vi.fn(async () => true);
const commitBatchMock = vi.fn(async (..._a: unknown[]) => ({ written: 1, skipped: 0 }));

vi.mock("@/core/auth/session", () => ({ isAuthenticated: () => authenticated() }));
vi.mock("@/modules/finance/import/commit", () => ({
  commitBatch: (...a: unknown[]) => commitBatchMock(...a),
}));
vi.mock("@/modules/finance/import/rollback", () => ({
  cancelBatch: vi.fn(async () => true),
  rollbackBatch: vi.fn(async () => ({ removed: 0 })),
}));
vi.mock("@/core/db", () => ({ prisma: {} }));

const { POST } = await import("./route");

function request(body: unknown): Request {
  return new Request("http://localhost/api/finance/import/b1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = Promise.resolve({ id: "b1" });

beforeEach(() => {
  authenticated.mockReset().mockResolvedValue(true);
  commitBatchMock.mockReset().mockResolvedValue({ written: 1, skipped: 0 });
});

describe("решения владельца доезжают до коммита", () => {
  it("«это настоящий доход» не теряется по дороге", async () => {
    const res = await POST(
      request({
        action: "commit",
        fingerprint: "fp",
        decisions: [{ index: 0, include: true, keepAsIncome: true }],
      }),
      { params },
    );

    expect(res.status).toBe(200);
    const passed = commitBatchMock.mock.calls[0]?.[0] as {
      decisions: Array<Record<string, unknown>>;
    };
    expect(passed.decisions[0]).toMatchObject({ index: 0, include: true, keepAsIncome: true });
  });

  it("остальные решения строки тоже доезжают", async () => {
    // Тот же класс ошибки может повториться с любым новым полем решения,
    // поэтому проверяем весь набор, а не только починенное.
    await POST(
      request({
        action: "commit",
        fingerprint: "fp",
        decisions: [
          {
            index: 3,
            include: true,
            categoryId: "cat_1",
            projectId: null,
            mergeTransfer: true,
            keepAsIncome: false,
          },
        ],
      }),
      { params },
    );

    const passed = commitBatchMock.mock.calls[0]?.[0] as {
      decisions: Array<Record<string, unknown>>;
    };
    expect(passed.decisions[0]).toEqual({
      index: 3,
      include: true,
      categoryId: "cat_1",
      projectId: null,
      mergeTransfer: true,
      keepAsIncome: false,
    });
  });

  it("без входа коммит не выполняется", async () => {
    authenticated.mockResolvedValue(false);
    const res = await POST(request({ action: "commit", fingerprint: "fp" }), { params });

    expect(res.status).toBe(401);
    expect(commitBatchMock).not.toHaveBeenCalled();
  });

  it("подтверждение без отпечатка предпросмотра отклоняется", async () => {
    const res = await POST(request({ action: "commit" }), { params });
    expect(res.status).toBe(400);
    expect(commitBatchMock).not.toHaveBeenCalled();
  });
});
