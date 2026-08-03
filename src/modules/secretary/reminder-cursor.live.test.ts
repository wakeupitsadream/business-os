import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/core/db";
import {
  resetReminderCursor,
  setEarliestReminder,
  shouldCheckReminders,
  reminderCursorState,
} from "./reminder-cursor";
import { deliverDueReminders } from "./reminders-job";
import { assertDisposableDatabase, liveDbEnabled } from "@/core/testing/live-db";

/**
 * Курсор против настоящей базы. Проверяется стык, которого не видно в юнитах:
 * что после похода в базу курсор встаёт на действительно ближайшее
 * напоминание, а не на то, что осталось в памяти.
 */

vi.mock("@/core/telegram/bot", () => ({
  tgNotifyOwner: async () => true,
  // Доставка напоминаний ходит через подробный вариант: от причины отказа
  // зависит, повторять ли (таймаут — никогда).
  tgNotifyOwnerDetailed: async () => ({ ok: true }),
  tgApi: async () => ({ ok: true }),
}));

const NOW = new Date("2026-07-30T12:00:00Z");

describe.runIf(liveDbEnabled)("курсор на живой базе", () => {
  beforeEach(async () => {
    // Первой строкой, до любого удаления: ниже идёт deleteMany без условий.
    assertDisposableDatabase();
    await prisma.reminder.deleteMany({});
    resetReminderCursor();
  });

  it("пустая база — курсор узнаёт, что ходить незачем", async () => {
    await deliverDueReminders(NOW);

    expect(reminderCursorState().knows).toBe(true);
    expect(reminderCursorState().earliest).toBeNull();
    expect(shouldCheckReminders(new Date(NOW.getTime() + 60_000))).toBe(false);
  });

  it("после доставки курсор встаёт на следующее напоминание", async () => {
    await prisma.reminder.create({
      data: { text: "первое", nextFireAt: new Date(NOW.getTime() - 1000), channel: "TELEGRAM" },
    });
    await prisma.reminder.create({
      data: { text: "второе", nextFireAt: new Date(NOW.getTime() + 3600_000), channel: "TELEGRAM" },
    });

    const res = await deliverDueReminders(NOW);
    expect(res.sent).toBe(1);

    // Разовое доставленное ушло в архив, ближайшим стало второе.
    expect(reminderCursorState().earliest?.toISOString()).toBe(
      new Date(NOW.getTime() + 3600_000).toISOString(),
    );
    expect(shouldCheckReminders(new Date(NOW.getTime() + 60_000))).toBe(false);
    expect(shouldCheckReminders(new Date(NOW.getTime() + 3600_000))).toBe(true);
  });

  it("повторяющееся напоминание оставляет курсор на своём следующем сроке", async () => {
    await prisma.reminder.create({
      data: {
        text: "каждый день",
        nextFireAt: new Date(NOW.getTime() - 1000),
        repeatPreset: "DAILY",
        channel: "TELEGRAM",
      },
    });

    await deliverDueReminders(NOW);

    const next = reminderCursorState().earliest;
    expect(next).not.toBeNull();
    // Следующий срок — в будущем, иначе крон зациклится на нём каждую минуту.
    expect(next!.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("курсор не обгоняет базу: что в памяти, то и в базе", async () => {
    await prisma.reminder.create({
      data: { text: "через час", nextFireAt: new Date(NOW.getTime() + 3600_000), channel: "TELEGRAM" },
    });
    setEarliestReminder(new Date("2030-01-01T00:00:00Z"), NOW);

    // Ежечасная сверка обязана поправить разъехавшийся курсор.
    expect(shouldCheckReminders(new Date(NOW.getTime() + 3600_000))).toBe(true);
    await deliverDueReminders(new Date(NOW.getTime() + 3600_000));

    const [row] = await prisma.$queryRaw<Array<{ min: Date | null }>>`
      SELECT MIN("nextFireAt") AS min FROM "Reminder" WHERE "isActive" = true
    `;
    expect(reminderCursorState().earliest?.toISOString() ?? null).toBe(
      row?.min?.toISOString() ?? null,
    );
  });
});
