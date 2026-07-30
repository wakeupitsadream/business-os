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
import { classifyMigrateFailure, looksPooled } from "./migrate-error-kind.mjs";

// В schema.prisma объявлен `directUrl = env("DIRECT_URL")` (миграции идут мимо
// PgBouncer). Если переменная не задана — подставляем DATABASE_URL, иначе
// Prisma откажется даже начать из-за отсутствующего env.
if (!process.env.DIRECT_URL && process.env.DATABASE_URL) {
  process.env.DIRECT_URL = process.env.DATABASE_URL;
  console.warn("⚠ DIRECT_URL не задан — для миграций используется DATABASE_URL.");

  // На Neon это чаще всего беда, а не мелкое неудобство: DATABASE_URL там
  // указывает на пул (PgBouncer в transaction mode), а `migrate deploy` берёт
  // advisory lock, который пул не пропускает. Миграция упадёт с ошибкой, ничем
  // не похожей на «забыли переменную», и причину будут искать долго.
  if (looksPooled(process.env.DATABASE_URL)) {
    console.warn(
      "⚠ DATABASE_URL похож на пул Neon (-pooler / pgbouncer=true). Миграции через пул\n" +
        "  не проходят: задайте DIRECT_URL — ту же строку подключения БЕЗ «-pooler».",
    );
  }
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

const kind = classifyMigrateFailure(res.out);

if (kind === "unreachable") {
  console.warn(
    "⚠ База недоступна — `migrate deploy` пропущен, контейнер стартует дальше.\n" +
      "  Когда база вернётся: перезапустить контейнер или выполнить `npm run db:migrate:deploy`.",
  );
  console.warn(res.out.trim().slice(0, 2000));
  process.exit(0);
}

if (kind === "pooler") {
  console.error(
    "✗ Миграции не проходят через пул соединений.\n" +
      "  Prisma берёт advisory lock, а PgBouncer в transaction mode его не пропускает.\n" +
      "  Задайте DIRECT_URL — строку подключения Neon БЕЗ «-pooler» и без pgbouncer=true.",
  );
  console.error(res.out.trim().slice(0, 2000));
  process.exit(1);
}

console.error("✗ `prisma migrate deploy` упал НЕ из-за доступа к базе:");
console.error(res.out);
process.exit(1);
