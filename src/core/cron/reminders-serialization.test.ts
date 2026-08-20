import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Замок на прогоне напоминаний.
 *
 * Планировщик контейнера стреляет `void fireCron(job)` — не дожидаясь
 * предыдущего вызова (scripts/start-container.mjs), — а пачка из десяти
 * напоминаний под медленным Telegram идёт минутами: три попытки по 15 с плюс
 * пауза по 429 до 30 с на каждое сообщение. Пересечение прогонов поэтому не
 * экзотика, а штатное поведение под нагрузкой, и стоит оно дорого: два прогона
 * читают одну и ту же строку и оба её отправляют.
 */

const deliverDueReminders = vi.fn(async () => ({ sent: 0, failed: 0 }));
const shouldCheckReminders = vi.fn(() => true);

vi.mock("@/modules/secretary/reminders-job", () => ({
  deliverDueReminders: () => deliverDueReminders(),
}));

vi.mock("@/modules/secretary/reminder-cursor", () => ({
  shouldCheckReminders: () => shouldCheckReminders(),
  backOffCursor: () => {},
  logCursor: () => {},
}));

vi.mock("@/core/db", () => ({
  prisma: { domainEvent: { create: vi.fn(async () => ({})) } },
}));

const { reminders } = await import("./jobs");

/** Прогон, который зависает, пока его не отпустят. */
function hanging() {
  let release: (v: { sent: number; failed: number }) => void = () => {};
  const promise = new Promise<{ sent: number; failed: number }>((r) => {
    release = r;
  });
  return { promise, release };
}

beforeEach(() => {
  deliverDueReminders.mockReset();
  shouldCheckReminders.mockReset();
  shouldCheckReminders.mockReturnValue(true);
  deliverDueReminders.mockResolvedValue({ sent: 0, failed: 0 });
});

describe("пересекающиеся тики", () => {
  it("второй тик не начинает доставку, пока идёт первый", async () => {
    const slow = hanging();
    deliverDueReminders.mockReturnValueOnce(slow.promise);

    const first = reminders();
    const second = await reminders();

    expect(deliverDueReminders).toHaveBeenCalledTimes(1);
    expect(second.ok).toBe(true);
    expect(second.detail).toContain("предыдущий прогон");

    slow.release({ sent: 1, failed: 0 });
    await first;
  });

  it("после завершения первого прогона замок снимается", async () => {
    const slow = hanging();
    deliverDueReminders.mockReturnValueOnce(slow.promise);

    const first = reminders();
    await reminders(); // пропущен
    slow.release({ sent: 1, failed: 0 });
    await first;

    await reminders();
    expect(deliverDueReminders).toHaveBeenCalledTimes(2);
  });

  it("упавший прогон не запирает джобу навсегда", async () => {
    // Иначе одна ошибка доставки останавливала бы напоминания до перезапуска
    // контейнера — а перезапускать его владельцу нечем.
    deliverDueReminders.mockRejectedValueOnce(new Error("база недоступна"));
    await expect(reminders()).rejects.toThrow("база недоступна");

    await reminders();
    expect(deliverDueReminders).toHaveBeenCalledTimes(2);
  });

  it("пропущенный тик не ходит в базу и не трогает курсор", async () => {
    const slow = hanging();
    deliverDueReminders.mockReturnValueOnce(slow.promise);

    const first = reminders();
    shouldCheckReminders.mockClear();
    await reminders();

    // Замок проверяется ДО курсора: пропущенному тику вообще незачем спрашивать.
    expect(shouldCheckReminders).not.toHaveBeenCalled();

    slow.release({ sent: 0, failed: 0 });
    await first;
  });
});
