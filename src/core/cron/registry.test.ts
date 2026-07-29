import { describe, expect, it } from "vitest";
import { CRON_HANDLERS, CRON_JOB_NAMES, getCronHandler } from "@/core/cron/registry";

describe("реестр крон-задач", () => {
  it("у каждого объявленного имени есть функция-обработчик", () => {
    expect(CRON_JOB_NAMES.length).toBeGreaterThan(0);
    for (const name of CRON_JOB_NAMES) {
      expect(typeof getCronHandler(name)).toBe("function");
    }
  });

  it("содержит задачи фазы 0", () => {
    expect(CRON_JOB_NAMES).toContain("heartbeat");
    expect(CRON_JOB_NAMES).toContain("cleanup-dedup");
  });

  it("на неизвестное имя возвращает undefined", () => {
    expect(getCronHandler("нет-такой-задачи")).toBeUndefined();
    expect(getCronHandler("")).toBeUndefined();
  });

  it("не выдаёт наследованные свойства объекта за обработчики", () => {
    // Имя приходит из URL: /api/cron/constructor не должен находить функцию.
    expect(getCronHandler("constructor")).toBeUndefined();
    expect(getCronHandler("toString")).toBeUndefined();
    expect(getCronHandler("__proto__")).toBeUndefined();
  });

  it("имена задач — в kebab-case (совпадают с сегментом URL)", () => {
    for (const name of Object.keys(CRON_HANDLERS)) {
      expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});
