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

  it("после успешной записи в течение часа не пишем повторно", async () => {
    const heartbeat = await loadHeartbeat();
    await heartbeat();
    const res = await heartbeat();

    expect(create).toHaveBeenCalledTimes(1);
    expect(res.detail).toContain("пропущено");
  });
});
