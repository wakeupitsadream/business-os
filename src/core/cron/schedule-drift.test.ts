import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CRON_JOB_NAMES } from "./registry";

/**
 * Расписание задач живёт в scripts/start-container.mjs (обычный JS, исполняется
 * до запуска сервера), а обработчики — в реестре. Это две копии одного списка
 * имён, и они молча разъезжаются: планировщик будет исправно дёргать
 * `/api/cron/опечатка`, роут будет исправно отвечать 404, и задача просто
 * никогда не выполнится. Ни компилятор, ни обычные тесты этого не увидят.
 *
 * Импортировать планировщик нельзя — при импорте он запускает миграции и
 * поднимает сервер. Поэтому читаем его как текст.
 */

const SCHEDULER = new URL("../../../scripts/start-container.mjs", import.meta.url);

function scheduledJobNames(): string[] {
  const source = readFileSync(SCHEDULER, "utf8");
  const names = new Set<string>();
  for (const m of source.matchAll(/job:\s*["']([^"']+)["']/g)) {
    const name = m[1];
    if (name) names.add(name);
  }
  return [...names];
}

describe("расписание планировщика и реестр обработчиков", () => {
  it("планировщик вообще содержит задачи", () => {
    expect(scheduledJobNames().length).toBeGreaterThan(0);
  });

  it("у каждой запланированной задачи есть обработчик", () => {
    const missing = scheduledJobNames().filter((n) => !CRON_JOB_NAMES.includes(n));
    expect(missing, `в планировщике есть задачи без обработчика: ${missing.join(", ")}`).toEqual([]);
  });

  it("каждый обработчик кем-то вызывается", () => {
    // Обратная сторона: обработчик без расписания — мёртвый код. Он может быть
    // нужен для ручного вызова, но тогда это осознанное решение, а не забывчивость.
    const scheduled = scheduledJobNames();
    const orphaned = CRON_JOB_NAMES.filter((n) => !scheduled.includes(n));
    expect(orphaned, `обработчики без расписания: ${orphaned.join(", ")}`).toEqual([]);
  });
});
