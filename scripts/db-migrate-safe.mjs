/**
 * Применение миграций Prisma на старте контейнера — без права уронить старт
 * из-за недоступной базы.
 *
 * Почему так: контейнер один и запускается на каждый деплой. Если `migrate
 * deploy` падает на блипе Neon (или на скейл-ту-зиро, или на просроченной
 * оплате), контейнер не поднимется вовсе — и владелец не увидит даже страницу
 * техработ и /api/health, по которым можно понять, что происходит.
 *
 * Правило разделения:
 *   • ошибка ДОСТУПА к базе  → предупреждение, выход 0 (код исправен, старт
 *     продолжается; миграции применятся на следующем деплое или руками
 *     `npm run db:migrate:deploy`);
 *   • НАСТОЯЩАЯ ошибка миграции (плохой SQL, дрейф схемы) → выход 1, старт
 *     отменяется. Работать против несмигрированной схемы хуже, чем не
 *     работать вовсе: половина запросов падает, данные пишутся частично.
 */

import { execSync } from "node:child_process";

// В schema.prisma объявлен `directUrl = env("DIRECT_URL")` (миграции идут мимо
// PgBouncer). Если переменная не задана — подставляем DATABASE_URL, иначе
// Prisma откажется даже начать из-за отсутствующего env.
if (!process.env.DIRECT_URL && process.env.DATABASE_URL) {
  process.env.DIRECT_URL = process.env.DATABASE_URL;
  console.warn("⚠ DIRECT_URL не задан — для миграций используется DATABASE_URL.");
}

if (!process.env.DATABASE_URL) {
  console.warn("⚠ DATABASE_URL не задан — миграции пропущены, старт продолжается.");
  process.exit(0);
}

// Режим техработ / явный пропуск: база заведомо недоступна или её чинят руками.
// Не тратим 20–30 секунд старта на заведомо неудачную попытку.
if (process.env.MAINTENANCE_MODE === "1" || process.env.SKIP_MIGRATIONS === "1") {
  console.warn("⚠ MAINTENANCE_MODE/SKIP_MIGRATIONS — миграции пропущены, старт продолжается.");
  process.exit(0);
}

/** Сбой ДОСТУПА к базе: недоступна, таймаут, отказ авторизации, оборванный SSL. */
function isConnectivityError(output) {
  return /P100[0-3]|P101[0137]|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ECONNRESET|Can't reach database|Timed out|authentication failed|password authentication|access denied|permission denied|terminating connection|Connection refused|could not connect|server closed the connection|SSL connection/i.test(
    output,
  );
}

function run(cmd) {
  try {
    const stdout = execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    return { ok: true, out: stdout ?? "" };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}${e.message ?? ""}` };
  }
}

const res = run("npx prisma migrate deploy");

if (res.ok) {
  process.stdout.write(res.out);
  console.log("✓ Миграции Prisma применены.");
  process.exit(0);
}

if (isConnectivityError(res.out)) {
  console.warn(
    "⚠ База недоступна — `migrate deploy` пропущен, контейнер стартует дальше.\n" +
      "  Когда база вернётся: перезапустить контейнер или выполнить `npm run db:migrate:deploy`.",
  );
  console.warn(res.out.trim().slice(0, 2000));
  process.exit(0);
}

console.error("✗ `prisma migrate deploy` упал НЕ из-за доступа к базе:");
console.error(res.out);
process.exit(1);
