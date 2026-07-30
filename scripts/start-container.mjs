/**
 * Точка входа Docker-контейнера (Timeweb App Platform).
 *
 * Делает три вещи:
 *   1. Применяет миграции через db-migrate-safe (блип базы не мешает старту,
 *      настоящая ошибка миграции — мешает).
 *   2. Поднимает standalone-сервер Next.js (server.js) и пробрасывает сигналы.
 *   3. Крутит встроенный планировщик: на Timeweb нет системных кронов, поэтому
 *      расписание живёт прямо здесь и дёргает /api/cron/<job> по localhost.
 *
 * Все расписания — в UTC (у контейнера нет гарантии локальной зоны; бизнес-
 * периоды режутся по Europe/Moscow уже внутри кода, см. core/shared/time.ts).
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = process.env.PORT || "3000";
process.env.HOSTNAME = "0.0.0.0";

// SHA сборки доступен всему приложению через окружение: /api/health и UI берут
// версию из process.env.BUILD_SHA, не читая файл в каждом рантайме.
if (!process.env.BUILD_SHA) {
  try {
    const sha = readFileSync(".build-sha", "utf8").trim();
    if (sha) process.env.BUILD_SHA = sha;
  } catch {
    // Вне Docker файла нет — это нормально, версия покажется как "local".
  }
}

// ---------- 1. Миграции ----------
await new Promise((resolve) => {
  const migrate = spawn("node", ["scripts/db-migrate-safe.mjs"], { stdio: "inherit" });
  migrate.on("exit", (code) => {
    if (code !== 0) {
      console.error(`✗ Миграции завершились с кодом ${code} — контейнер не стартует.`);
      process.exit(code ?? 1);
    }
    resolve();
  });
  migrate.on("error", (e) => {
    console.error("✗ Не удалось запустить миграции:", e);
    process.exit(1);
  });
});

// ---------- 2. Сервер ----------
const server = spawn("node", ["server.js"], { stdio: "inherit", env: process.env });
server.on("exit", (code) => process.exit(code ?? 0));
server.on("error", (e) => {
  console.error("✗ Не удалось запустить server.js:", e);
  process.exit(1);
});
// NEXT_MANUAL_SIG_HANDLE=true в образе: сигналы гасит приложение, а не рантайм
// Next — иначе контейнер умирает мгновенно, обрывая начатые ответы агента.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill(signal));
}

// ---------- 3. Планировщик (UTC) ----------
/**
 * Расписание задач. Формат декларативный:
 *   { job, everyMinutes }               — раз в N минут (N делит 60);
 *   { job, hourUtc, minute, weekdayUtc? } — в указанное время UTC.
 *
 * Сюда по мере роста добавятся: daily-brief (04:30 UTC = 07:30 МСК),
 * reminders (everyMinutes: 1), day-summary, yookassa-sync, lead-followups.
 * Имя job обязано существовать в src/core/cron/registry.ts, иначе роут вернёт
 * 404 и это будет видно в логе строкой `[cron] … → 404`.
 */
const CRON_JOBS = [
  { job: "reminders", everyMinutes: 1 },
  { job: "evening-checkin", hourUtc: 18, minute: 30 },
  { job: "heartbeat", everyMinutes: 10 },
  { job: "cleanup-dedup", hourUtc: 3, minute: 30 },
];

function shouldFire(job, now) {
  if (job.everyMinutes !== undefined) {
    return now.getUTCMinutes() % job.everyMinutes === 0;
  }
  if (job.weekdayUtc !== undefined && now.getUTCDay() !== job.weekdayUtc) return false;
  return now.getUTCHours() === job.hourUtc && now.getUTCMinutes() === job.minute;
}

async function fireCron(job) {
  const url = `http://127.0.0.1:${PORT}/api/cron/${job.job}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` },
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
    console.log(`[cron] ${job.job} → ${res.status}`);
  } catch (e) {
    // Падение одной задачи не должно ронять цикл: следующая минута наступит.
    console.error(`[cron] ${job.job} упал:`, e?.message ?? e);
  }
}

async function cronLoop() {
  await sleep(30_000); // даём серверу подняться, иначе первый тик уйдёт в ECONNREFUSED

  let lastMinuteKey = "";
  for (;;) {
    try {
      const now = new Date();
      const minuteKey = now.toISOString().slice(0, 16); // дедуп внутри процесса
      if (minuteKey !== lastMinuteKey) {
        lastMinuteKey = minuteKey;
        for (const job of CRON_JOBS) {
          if (shouldFire(job, now)) void fireCron(job);
        }
      }
    } catch (e) {
      console.error("[cron] сбой планировщика:", e?.message ?? e);
    }
    await sleep(20_000);
  }
}

void cronLoop();
