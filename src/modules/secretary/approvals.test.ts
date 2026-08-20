import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * Исполнитель отложенных действий.
 *
 * Деньги здесь настоящие: типичная заявка — расход от 50 000 ₽. Поэтому
 * главные свойства — «дважды не исполняется» и «сбой не закрывает заявку»,
 * а не happy path.
 */

const findUnique = vi.fn(async (..._a: unknown[]) => null as unknown);
const update = vi.fn(async (..._a: unknown[]) => ({}));
const updateMany = vi.fn(async (..._a: unknown[]) => ({ count: 1 }));

vi.mock("@/core/db", () => ({
  prisma: {
    notification: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      update: (...a: unknown[]) => update(...a),
    },
    agentAction: { updateMany: (...a: unknown[]) => updateMany(...a) },
  },
}));

const execute = vi.fn(async (..._a: unknown[]) => ({ ok: true, message: "Записал 60 000 ₽" }));
vi.mock("./agent", () => ({
  secretaryRegistry: {
    get: (name: string) =>
      name === "add_transaction"
        ? {
            name,
            description: "запись операции",
            schema: z.object({ amount: z.string() }),
            execute: (...a: unknown[]) => execute(...a),
          }
        : undefined,
  },
}));

const { resolveApproval } = await import("./approvals");

function pending(over: Record<string, unknown> = {}) {
  return {
    id: "n1",
    type: "APPROVAL_REQUIRED",
    resolvedAt: null,
    resolution: null,
    payload: { actionId: "a1", toolName: "add_transaction", args: { amount: "60000" } },
    ...over,
  };
}

beforeEach(() => {
  findUnique.mockReset();
  update.mockReset();
  updateMany.mockReset();
  execute.mockReset();
  update.mockResolvedValue({});
  updateMany.mockResolvedValue({ count: 1 });
  execute.mockResolvedValue({ ok: true, message: "Записал 60 000 ₽" });
});

describe("исполнение", () => {
  it("одобрение исполняет инструмент и закрывает заявку", async () => {
    findUnique.mockResolvedValue(pending());
    const out = await resolveApproval("n1", true, "TELEGRAM");

    expect(out.status).toBe("executed");
    expect(execute).toHaveBeenCalledTimes(1);
    // Канал доезжает до инструмента: от него зависит источник записей.
    const ctx = execute.mock.calls[0]?.[1] as { channel: string };
    expect(ctx.channel).toBe("TELEGRAM");
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("отклонение не исполняет ничего", async () => {
    findUnique.mockResolvedValue(pending());
    const out = await resolveApproval("n1", false, "WEB");
    expect(out.status).toBe("rejected");
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("дважды не исполняется", () => {
  it("уже решённая заявка отвечает словами, а не повтором действия", async () => {
    findUnique.mockResolvedValue(pending({ resolvedAt: new Date(), resolution: "APPROVED" }));
    const out = await resolveApproval("n1", true, "TELEGRAM");

    expect(out.status).toBe("already");
    expect(out.message).toContain("уже");
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("сбой не закрывает заявку", () => {
  it("исключение инструмента оставляет заявку живой для повтора", async () => {
    // База моргнула на исполнении — решение владельца не отменяется этим.
    findUnique.mockResolvedValue(pending());
    execute.mockRejectedValue(new Error("база недоступна"));

    const out = await resolveApproval("n1", true, "TELEGRAM");

    expect(out.status).toBe("failed");
    expect(update).not.toHaveBeenCalled(); // resolvedAt не выставлен
  });
});

describe("защита от рассинхрона с деплоем", () => {
  it("исчезнувший инструмент закрывает заявку отказом, а не падает", async () => {
    findUnique.mockResolvedValue(
      pending({ payload: { actionId: "a1", toolName: "нет_такого", args: {} } }),
    );
    const out = await resolveApproval("n1", true, "WEB");
    expect(out.status).toBe("invalid");
    expect(execute).not.toHaveBeenCalled();
  });

  it("аргументы, не подходящие новой схеме, закрывают заявку отказом", async () => {
    findUnique.mockResolvedValue(
      pending({ payload: { actionId: "a1", toolName: "add_transaction", args: { amount: 5 } } }),
    );
    const out = await resolveApproval("n1", true, "WEB");
    expect(out.status).toBe("invalid");
    expect(execute).not.toHaveBeenCalled();
  });

  it("чужое или несуществующее уведомление — «не найдено»", async () => {
    findUnique.mockResolvedValue(null);
    const out = await resolveApproval("нет", true, "TELEGRAM");
    expect(out.status).toBe("not_found");
  });
});
