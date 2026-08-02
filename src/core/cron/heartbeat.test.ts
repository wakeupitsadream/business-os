import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Пульс системы.
 *
 * Смысл пульса ровно один: доказать, что планировщик жив И база пишется. Из
 * этого следует требование, которое легко потерять при оптимизации — отметка
 * «уже записывали в этом часу» обязана ставиться ПОСЛЕ успешной записи.
 * Поставленная до, она глушит пульс на час именно тогда, когда база отвалилась,
 * то есть ровно в тот момент, ради которого пульс и заведён.
 */

const create = vi.fn(async (..._a: unknown[]) => ({}));

vi.mock("@/core/db", () => ({
  prisma: { domainEvent: { create: (...a: unknown[]) => create(...a) } },
}));

/**
 * Отметка живёт в модуле, а не в базе, — поэтому модуль грузится заново на
 * каждый тест. Иначе первый же успешный пульс заглушил бы все следующие тесты
 * этого файла, и они проверяли бы состояние, оставшееся от соседа.
 */
async function loadHeartbeat() {
  vi.resetModules();
  return (await import("./jobs")).heartbeat;
}

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue({});
});

describe("отметка о записи", () => {
  it("упавшая запись не съедает следующий час", async () => {
    const heartbeat = await loadHeartbeat();
    create.mockRejectedValueOnce(new Error("база недоступна"));
    await expect(heartbeat()).rejects.toThrow("база недоступна");

    // Следующий вызов обязан снова попробовать записать, а не отрапортовать
    // «пропущено: запись уже была».
    const res = await heartbeat();
    expect(create).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(true);
  });

  it("после успешной записи в тех же сутках не пишем повторно", async () => {
    const heartbeat = await loadHeartbeat();
    await heartbeat();
    const res = await heartbeat();

    expect(create).toHaveBeenCalledTimes(1);
    expect(res.detail).toContain("пропущено");
  });
});

describe("частота пульса", () => {
  /**
   * Пульс раз в сутки, а не раз в час: 24 пробуждения компьюта Neon в сутки
   * ради одной строки в ленте — это порядка 15 CU-часов в месяц из ста общих с
   * Agentus. Живость планировщика и так видна в логе строкой `[cron] … → 200`
   * на каждую задачу каждую минуту; своё у пульса остаётся одно — доказать, что
   * база ПИШЕТСЯ, и для этого суток достаточно.
   */
  it("за сутки минутных тиков пишется ровно один раз", async () => {
    const heartbeat = await loadHeartbeat();
    const start = new Date("2026-08-01T00:00:00Z").getTime();
    const spy = vi.spyOn(Date, "now");

    // Пульс дёргается раз в 10 минут — 144 раза в сутки.
    for (let tick = 0; tick < 144; tick += 1) {
      spy.mockReturnValue(start + tick * 10 * 60_000);
      await heartbeat();
    }
    spy.mockRestore();

    expect(create).toHaveBeenCalledTimes(1);
  });

  it("новые сутки — новая запись", async () => {
    const heartbeat = await loadHeartbeat();
    const spy = vi.spyOn(Date, "now");

    spy.mockReturnValue(new Date("2026-08-01T23:50:00Z").getTime());
    await heartbeat();
    spy.mockReturnValue(new Date("2026-08-02T00:00:00Z").getTime());
    await heartbeat();
    spy.mockRestore();

    expect(create).toHaveBeenCalledTimes(2);
  });

  it("сетка суточная от полуночи UTC — та же, что у resync курсора", async () => {
    // Совпадение намеренное: два независимых расписания будили бы компьют в
    // разные минуты и платили за два пробуждения вместо одного, а расход
    // зависел бы от минуты, в которую случайно стартовал контейнер.
    const heartbeat = await loadHeartbeat();
    const spy = vi.spyOn(Date, "now");

    // 00:05 и 23:55 одних суток — одна запись.
    spy.mockReturnValue(new Date("2026-08-01T00:05:00Z").getTime());
    await heartbeat();
    spy.mockReturnValue(new Date("2026-08-01T23:55:00Z").getTime());
    await heartbeat();
    spy.mockRestore();

    expect(create).toHaveBeenCalledTimes(1);
  });
});
