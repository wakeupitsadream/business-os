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
  deliveryAttempts: number;
  retryOf: Date | null;
}

const findMany = vi.fn(async (..._a: unknown[]) => [] as Row[]);
const findFirst = vi.fn(async (..._a: unknown[]) => null as { nextFireAt: Date } | null);
const update = vi.fn(async (..._a: unknown[]) => ({}));
const notify = vi.fn(async (..._a: unknown[]) => true);

/** Порядок вызовов — чтобы доказать, что сдвиг идёт до отправки. */
const order: string[] = [];

vi.mock("@/core/db", () => ({
  prisma: {
    reminder: {
      findMany: (...a: unknown[]) => findMany(...a),
      // Без этой заглушки refreshCursor падал бы на каждом тесте, а его
      // try/catch превращал бы падение в тихий logWarn: все сценарии ниже
      // проверяли бы отказ курсора вместо его работы.
      findFirst: (...a: unknown[]) => findFirst(...a),
      update: (...a: unknown[]) => {
        order.push("update");
        return update(...a);
      },
      // Захват строки идёт через updateMany с условием на прежний срок: при
      // деплое два контейнера видят одно напоминание, и обновиться оно должно
      // ровно у одного. Заглушка отдаёт count из того же `update`, чтобы
      // сценарии «база отказала» ниже продолжали работать.
      updateMany: async (...a: unknown[]) => {
        order.push("update");
        await update(...a);
        return { count: 1 };
      },
    },
  },
}));

vi.mock("@/core/telegram/bot", () => ({
  tgNotifyOwnerDetailed: async (...a: unknown[]) => {
    order.push("send");
    const ok = await notify(...a);
    return ok ? { ok: true } : { ok: false, reason: "failed" };
  },
}));

vi.mock("@/core/settings", () => ({
  getOwnerTimezone: async () => "Europe/Moscow",
}));

const { deliverDueReminders, formatReminder } = await import("./reminders-job");
const { reminderCursorState, resetReminderCursor, shouldCheckReminders } = await import(
  "./reminder-cursor"
);

const NOW = new Date("2026-07-29T09:00:00Z");

beforeEach(() => {
  findMany.mockReset();
  findFirst.mockReset();
  update.mockReset();
  notify.mockReset();
  order.length = 0;
  findMany.mockResolvedValue([]);
  findFirst.mockResolvedValue(null);
  update.mockResolvedValue({});
  notify.mockResolvedValue(true);
  resetReminderCursor();
});

function row(over: Partial<Row> = {}): Row {
  return {
    id: "r1",
    text: "позвонить в банк",
    nextFireAt: new Date("2026-07-29T08:59:00Z"),
    repeatPreset: null,
    deliveryAttempts: 0,
    retryOf: null,
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

describe("курсор после похода в базу", () => {
  /**
   * Раз мы уже сходили в базу, курсор обязан выйти обновлённым — иначе крон
   * либо будит компьют каждую минуту зря, либо (хуже) остаётся с курсором
   * ПОЗЖЕ настоящего ближайшего срока и просыпает напоминание.
   */
  const LATER = new Date("2026-07-29T10:00:00Z");

  it("пустая выборка тоже обновляет курсор", async () => {
    await deliverDueReminders(NOW);

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(reminderCursorState().knows).toBe(true);
    expect(reminderCursorState().earliest).toBeNull();
  });

  it("курсор встаёт на то, что ответила база", async () => {
    findMany.mockResolvedValue([row()]);
    findFirst.mockResolvedValue({ nextFireAt: LATER });

    await deliverDueReminders(NOW);

    expect(reminderCursorState().earliest?.toISOString()).toBe(LATER.toISOString());
    expect(shouldCheckReminders(new Date("2026-07-29T09:30:00Z"))).toBe(false);
    expect(shouldCheckReminders(LATER)).toBe(true);
  });

  it("остаток за границей пачки не даёт курсору уехать в будущее", async () => {
    // Пачка ограничена, а хвост очереди всё ещё просрочен: курсор обязан
    // остаться в прошлом, чтобы следующая минута забрала остаток.
    const tail = new Date("2026-07-29T08:59:00Z");
    findMany.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => row({ id: `r${i}` })),
    );
    findFirst.mockResolvedValue({ nextFireAt: tail });

    await deliverDueReminders(NOW);

    expect(reminderCursorState().earliest?.toISOString()).toBe(tail.toISOString());
    expect(shouldCheckReminders(NOW)).toBe(true);
  });

  it("неудавшийся сдвиг оставляет курсор в прошлом", async () => {
    // Запись осталась активной и просроченной — база вернёт её же, и
    // следующий тик обязан прийти за ней снова.
    findMany.mockResolvedValue([row()]);
    update.mockRejectedValue(new Error("база недоступна"));
    findFirst.mockResolvedValue({ nextFireAt: row().nextFireAt });

    await deliverDueReminders(NOW);

    expect(reminderCursorState().earliest?.toISOString()).toBe(row().nextFireAt.toISOString());
    expect(shouldCheckReminders(NOW)).toBe(true);
  });

  it("сбой самого запроса курсора не роняет доставку и оставляет «не знаю»", async () => {
    findMany.mockResolvedValue([row()]);
    findFirst.mockRejectedValue(new Error("база недоступна"));

    const res = await deliverDueReminders(NOW);

    expect(res.sent).toBe(1);
    // Курсор не знает состояния базы — значит следующий тик сходит сам.
    expect(reminderCursorState().knows).toBe(false);
    expect(shouldCheckReminders(NOW)).toBe(true);
  });
});
