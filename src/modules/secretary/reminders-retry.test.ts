import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Недоставленное напоминание.
 *
 * Расписание сдвигается ДО отправки — иначе падение после отправки давало бы
 * один и тот же будильник раз в минуту. Обратную сторону этого порядка до сих
 * пор ничем не подбирали: блип Telegram на минуту уничтожал напоминание
 * совсем, и владелец узнавал об этом только по тому, что его не разбудили.
 *
 * Здесь проверяется и подбор, и его граница: таймаут не повторяется никогда.
 */

const notifyMock = vi.fn();
const reminderFindMany = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const reminderUpdateMany = vi.fn(async (..._a: unknown[]) => ({ count: 1 }));
const reminderFindFirst = vi.fn(async (..._a: unknown[]) => null as unknown);
const eventCreate = vi.fn(async (..._a: unknown[]) => ({ id: "e1" }));

vi.mock("@/core/telegram/bot", () => ({
  tgNotifyOwnerDetailed: (...a: unknown[]) => notifyMock(...a),
}));

vi.mock("@/core/db", () => ({
  prisma: {
    reminder: {
      findMany: (...a: unknown[]) => reminderFindMany(...a),
      updateMany: (...a: unknown[]) => reminderUpdateMany(...a),
      findFirst: (...a: unknown[]) => reminderFindFirst(...a),
    },
    domainEvent: { create: (...a: unknown[]) => eventCreate(...a) },
    settings: { findUnique: vi.fn(async () => null) },
  },
}));

const { deliverDueReminders } = await import("./reminders-job");

const NOW = new Date("2026-08-03T09:00:00Z");

function due(over: Record<string, unknown> = {}) {
  return [
    {
      id: "r1",
      text: "выпить таблетку",
      nextFireAt: new Date("2026-08-03T08:59:00Z"),
      repeatPreset: null,
      deliveryAttempts: 0,
      retryOf: null,
      ...over,
    },
  ];
}

/** Аргументы data того updateMany, который вернул напоминание в очередь. */
function retryWrite() {
  return reminderUpdateMany.mock.calls
    .map((c) => c[0] as { data?: Record<string, unknown> })
    .find((c) => c.data && "nextFireAt" in c.data && "retryOf" in c.data);
}

beforeEach(() => {
  notifyMock.mockReset();
  reminderFindMany.mockReset().mockResolvedValue([]);
  reminderUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  reminderFindFirst.mockReset().mockResolvedValue(null);
  eventCreate.mockReset().mockResolvedValue({ id: "e1" });
});

describe("недоставленное возвращается в очередь", () => {
  it("отказ Telegram ставит повтор через две минуты", async () => {
    reminderFindMany.mockResolvedValue(due());
    notifyMock.mockResolvedValue({ ok: false, reason: "failed" });

    const res = await deliverDueReminders(NOW);

    expect(res.failed).toBe(1);
    const write = retryWrite();
    expect(write?.data?.deliveryAttempts).toBe(1);
    expect((write?.data?.nextFireAt as Date).getTime()).toBe(NOW.getTime() + 2 * 60 * 1000);
    // Повтор не должен уводить расписание: настоящий срок сохранён отдельно.
    expect((write?.data?.retryOf as Date).toISOString()).toBe("2026-08-03T08:59:00.000Z");
    // Разовое напоминание для повтора снова включается.
    expect(write?.data?.isActive).toBe(true);
  });

  it("ТАЙМАУТ не повторяется — сообщение скорее всего дошло", async () => {
    // Инвариант всей отправки в этом репозитории: при таймауте потерян ответ,
    // а не запрос. Повтор здесь — второй будильник владельцу среди ночи.
    reminderFindMany.mockResolvedValue(due());
    notifyMock.mockResolvedValue({ ok: false, reason: "timeout" });

    await deliverDueReminders(NOW);

    expect(retryWrite()).toBeUndefined();
    // Но и молчать нельзя: раз не знаем, дошло ли, — это видно в ленте.
    const event = eventCreate.mock.calls[0]?.[0] as { data: { type: string; payload: { kind: string } } };
    expect(event.data.type).toBe("reminder.undelivered");
    expect(event.data.payload.kind).toBe("uncertain");
  });

  it("после пятой попытки сдаёмся и говорим об этом в ленте", async () => {
    // Ненаступившее напоминание выглядит ровно так же, как ненужное.
    reminderFindMany.mockResolvedValue(due({ deliveryAttempts: 4 }));
    notifyMock.mockResolvedValue({ ok: false, reason: "failed" });

    await deliverDueReminders(NOW);

    expect(retryWrite()).toBeUndefined();
    const event = eventCreate.mock.calls[0]?.[0] as {
      data: { type: string; title: string; payload: { kind: string; attempts: number } };
    };
    expect(event.data.type).toBe("reminder.undelivered");
    expect(event.data.payload).toMatchObject({ kind: "gave-up", attempts: 5 });
    expect(event.data.title).toContain("выпить таблетку");
  });

  it("успех обнуляет счётчик попыток", async () => {
    reminderFindMany.mockResolvedValue(due({ deliveryAttempts: 3 }));
    notifyMock.mockResolvedValue({ ok: true });

    const res = await deliverDueReminders(NOW);

    expect(res.sent).toBe(1);
    const cleared = reminderUpdateMany.mock.calls
      .map((c) => c[0] as { data?: Record<string, unknown> })
      .find((c) => c.data && Object.keys(c.data).length === 1 && c.data.deliveryAttempts === 0);
    expect(cleared).toBeDefined();
  });

  it("успех без прошлых неудач лишнего запроса не делает", async () => {
    reminderFindMany.mockResolvedValue(due());
    notifyMock.mockResolvedValue({ ok: true });

    await deliverDueReminders(NOW);

    // Один updateMany — сам захват. Обнулять нечего.
    expect(reminderUpdateMany).toHaveBeenCalledTimes(1);
  });
});

describe("захват строки", () => {
  it("отправки нет, если строку успел забрать другой контейнер", async () => {
    // При деплое новый контейнер поднят, старый ещё жив: оба видят одну строку.
    reminderFindMany.mockResolvedValue(due());
    reminderUpdateMany.mockResolvedValue({ count: 0 });

    const res = await deliverDueReminders(NOW);

    expect(notifyMock).not.toHaveBeenCalled();
    expect(res.sent).toBe(0);
  });

  it("захват идёт по прежнему сроку, а не просто по идентификатору", async () => {
    reminderFindMany.mockResolvedValue(due());
    notifyMock.mockResolvedValue({ ok: true });

    await deliverDueReminders(NOW);

    const where = (reminderUpdateMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ id: "r1", isActive: true });
    expect((where.nextFireAt as Date).toISOString()).toBe("2026-08-03T08:59:00.000Z");
  });

  it("повтор считает следующий срок от настоящего, а не от времени повтора", async () => {
    // Иначе ежедневное напоминание на 9:00 после трёх неудач станет на 9:06.
    reminderFindMany.mockResolvedValue(
      due({
        repeatPreset: "DAILY",
        nextFireAt: new Date("2026-08-03T09:02:00Z"),
        retryOf: new Date("2026-08-03T06:00:00Z"),
        deliveryAttempts: 1,
      }),
    );
    notifyMock.mockResolvedValue({ ok: true });

    await deliverDueReminders(NOW);

    const data = (reminderUpdateMany.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    // Следующее срабатывание отсчитано от 06:00, а не от 09:02.
    expect((data.nextFireAt as Date).toISOString()).toBe("2026-08-04T06:00:00.000Z");
    expect(data.retryOf).toBeNull();
  });
});

describe("база не ответила", () => {
  it("курсор отходит на пять минут, а не остаётся в «не знаю»", async () => {
    // «Не знаю» означает «ходить каждую минуту»: при недоступной базе минутный
    // крон начинал бы долбить её ровно тогда, когда ей и без него плохо.
    const { reminderCursorState, resetReminderCursor } = await import("./reminder-cursor");
    resetReminderCursor();
    reminderFindMany.mockRejectedValue(new Error("база недоступна"));

    const res = await deliverDueReminders(NOW);

    expect(res).toEqual({ sent: 0, failed: 0 });
    const state = reminderCursorState();
    expect(state.knows).toBe(true);
    expect(state.earliest?.getTime()).toBe(NOW.getTime() + 5 * 60 * 1000);
  });
});
