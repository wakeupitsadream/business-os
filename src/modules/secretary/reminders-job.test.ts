import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Тесты доставки напоминаний.
 *
 * Главный риск здесь не «не отправили», а «отправили и не отметили»: такое
 * напоминание уходит владельцу снова на следующей минуте, и так до конца
 * времён. Поэтому порядок операций проверяется явно.
 */

interface Row {
  id: string;
  text: string;
  nextFireAt: Date;
  repeatPreset: string | null;
}

const findMany = vi.fn(async (..._a: unknown[]) => [] as Row[]);
const update = vi.fn(async (..._a: unknown[]) => ({}));
const notify = vi.fn(async (..._a: unknown[]) => true);

/** Порядок вызовов — чтобы доказать, что сдвиг идёт до отправки. */
const order: string[] = [];

vi.mock("@/core/db", () => ({
  prisma: {
    reminder: {
      findMany: (...a: unknown[]) => findMany(...a),
      update: (...a: unknown[]) => {
        order.push("update");
        return update(...a);
      },
    },
  },
}));

vi.mock("@/core/telegram/bot", () => ({
  tgNotifyOwner: (...a: unknown[]) => {
    order.push("send");
    return notify(...a);
  },
}));

vi.mock("@/core/settings", () => ({
  getOwnerTimezone: async () => "Europe/Moscow",
}));

const { deliverDueReminders, formatReminder } = await import("./reminders-job");

const NOW = new Date("2026-07-29T09:00:00Z");

beforeEach(() => {
  findMany.mockReset();
  update.mockReset();
  notify.mockReset();
  order.length = 0;
  findMany.mockResolvedValue([]);
  update.mockResolvedValue({});
  notify.mockResolvedValue(true);
});

function row(over: Partial<Row> = {}): Row {
  return {
    id: "r1",
    text: "позвонить в банк",
    nextFireAt: new Date("2026-07-29T08:59:00Z"),
    repeatPreset: null,
    ...over,
  };
}

describe("нечего отправлять", () => {
  it("пустая выборка не трогает Telegram", async () => {
    const res = await deliverDueReminders(NOW);
    expect(res).toEqual({ sent: 0, failed: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it("выбирает только активные и уже наступившие", async () => {
    await deliverDueReminders(NOW);
    const where = (findMany.mock.calls[0]?.[0] ?? {}) as {
      where?: { isActive?: boolean; nextFireAt?: { lte?: Date } };
    };
    expect(where.where?.isActive).toBe(true);
    expect(where.where?.nextFireAt?.lte).toEqual(NOW);
  });
});

describe("разовое напоминание", () => {
  it("отправляется и уходит в архив", async () => {
    findMany.mockResolvedValue([row()]);
    const res = await deliverDueReminders(NOW);

    expect(res.sent).toBe(1);
    expect(notify).toHaveBeenCalledWith(formatReminder("позвонить в банк"));

    const data = (update.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.isActive).toBe(false);
  });
});

describe("повторяющееся напоминание", () => {
  it("получает следующий срок в будущем, а не отключается", async () => {
    findMany.mockResolvedValue([row({ repeatPreset: "DAILY" })]);
    await deliverDueReminders(NOW);

    const data = (update.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.isActive).toBeUndefined();
    expect((data.nextFireAt as Date).getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe("порядок операций защищает от дублей", () => {
  it("расписание сдвигается ДО отправки", async () => {
    // Наоборот было бы хуже: упасть между отправкой и сдвигом — значит слать
    // одно и то же раз в минуту, пока владелец не выключит бота.
    findMany.mockResolvedValue([row({ repeatPreset: "DAILY" })]);
    await deliverDueReminders(NOW);
    expect(order).toEqual(["update", "send"]);
  });

  it("если сдвинуть не удалось — не отправляем вовсе", async () => {
    findMany.mockResolvedValue([row()]);
    update.mockRejectedValue(new Error("база недоступна"));

    const res = await deliverDueReminders(NOW);

    expect(notify).not.toHaveBeenCalled();
    expect(res.failed).toBe(1);
    expect(res.sent).toBe(0);
  });
});

describe("сбой доставки", () => {
  it("не роняет остальную пачку", async () => {
    findMany.mockResolvedValue([row({ id: "r1" }), row({ id: "r2", text: "второе" })]);
    notify.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const res = await deliverDueReminders(NOW);

    expect(res.sent).toBe(1);
    expect(res.failed).toBe(1);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("исключение Telegram тоже не роняет пачку", async () => {
    findMany.mockResolvedValue([row({ id: "r1" }), row({ id: "r2" })]);
    notify.mockRejectedValueOnce(new Error("сеть")).mockResolvedValueOnce(true);

    const res = await deliverDueReminders(NOW);
    expect(res.sent).toBe(1);
    expect(res.failed).toBe(1);
  });
});

describe("накопившиеся напоминания", () => {
  it("берутся ограниченной пачкой, а не стеной сообщений", async () => {
    await deliverDueReminders(NOW);
    const args = (findMany.mock.calls[0]?.[0] ?? {}) as { take?: number };
    expect(args.take).toBeGreaterThan(0);
    expect(args.take).toBeLessThanOrEqual(20);
  });
});
