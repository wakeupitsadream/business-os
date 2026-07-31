#!/usr/bin/env node
/**
 * Резервная копия базы — со сразу же проверенным восстановлением.
 *
 * Почему проверка встроена, а не «потом когда-нибудь». Разбор от 30.07 отдельно
 * отметил: резервных копий у системы нет вообще, и поэтому любая ошибка в учёте
 * необратима. Но копия, которую ни разу не разворачивали, — это не копия, а
 * надежда: битый дамп, забытое расширение, нехватка прав на восстановление
 * обнаруживаются ровно в тот день, когда данные уже потеряны.
 *
 * Поэтому по умолчанию скрипт делает три вещи подряд:
 *   1. снимает дамп через pg_dump (формат custom — он сжат и позволяет
 *      восстанавливать выборочно);
 *   2. поднимает временную базу и разворачивает дамп в неё;
 *   3. сверяет количество строк в ключевых таблицах с исходной базой и
 *      временную базу сносит.
 *
 * Несовпадение хотя бы одной цифры — ненулевой код возврата. «Похоже, всё
 * хорошо» тут не бывает.
 *
 * Запуск:
 *   node scripts/db-backup.mjs                 # дамп + репетиция восстановления
 *   node scripts/db-backup.mjs --no-verify     # только дамп (быстрее)
 *   node scripts/db-backup.mjs --out ~/backups # куда складывать
 *
 * Берёт DIRECT_URL (прямое подключение), а не DATABASE_URL: у пула PgBouncer
 * нет части протокола, которая нужна pg_dump.
 *
 * ВАЖНО: это дополнение к PITR на стороне Neon, а не замена. PITR спасает от
 * «удалил не то десять минут назад», файловый дамп — от потери проекта целиком
 * и от истёкшего окна PITR. Ни один из двух не покрывает случай другого.
 */

import { spawn } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** Таблицы, по которым сверяются строки. Деньги и всё, что нельзя восстановить руками. */
const CHECKED_TABLES = [
  "Transaction",
  "Account",
  "Category",
  "ImportBatch",
  "Task",
  "Reminder",
  "MemoryFact",
  "Insight",
];

const args = process.argv.slice(2);
const verify = !args.includes("--no-verify");
const outDir = resolve(valueOf("--out") ?? "backups");

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Строку подключения не печатаем никогда — в ней пароль. */
function describe(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}/${u.pathname.replace(/^\//, "")}`;
  } catch {
    return "(не разбирается как URL)";
  }
}

function run(cmd, argv, opts = {}) {
  return new Promise((done, fail) => {
    const child = spawn(cmd, argv, { stdio: opts.stdio ?? "inherit", env: process.env });
    let out = "";
    if (opts.stdio === "pipe") {
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
    }
    child.on("error", (e) =>
      fail(new Error(`не удалось запустить ${cmd}: ${e.message}. Установлен ли postgresql-client?`)),
    );
    child.on("exit", (code) =>
      code === 0 ? done(out) : fail(new Error(`${cmd} завершился с кодом ${code}${out ? `\n${out}` : ""}`)),
    );
  });
}

async function countRows(url, table) {
  const out = await run("psql", [url, "-tAc", `SELECT count(*) FROM "${table}"`], { stdio: "pipe" });
  return Number.parseInt(out.trim(), 10);
}

async function main() {
  const source = process.env.DIRECT_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!source) {
    console.error("✗ Не задан DIRECT_URL (или DATABASE_URL) — снимать нечего.");
    process.exit(1);
  }
  if (process.env.DIRECT_URL?.includes("-pooler")) {
    console.warn("⚠ DIRECT_URL похож на пуловый (-pooler). pg_dump требует прямого подключения.");
  }

  mkdirSync(outDir, { recursive: true });
  // Имя со временем, а не «latest»: перезапись последней копии тем же битым
  // дампом — классический способ остаться без копий вообще.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const file = join(outDir, `business-os-${stamp}.dump`);

  console.log(`→ Снимаю дамп ${describe(source)} → ${file}`);
  try {
    await run("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--file", file, source]);
  } catch (e) {
    // Обрывок дампа удаляем: файл нулевого размера в папке с копиями выглядит
    // как копия и ровно этим опасен.
    rmSync(file, { force: true });
    throw e;
  }
  const sizeMb = (statSync(file).size / 1024 / 1024).toFixed(2);
  console.log(`✓ Дамп снят, ${sizeMb} МБ`);

  if (!verify) {
    console.log("• Репетиция восстановления пропущена (--no-verify). Копия непроверенная.");
    return;
  }

  // Временная база рядом с исходной: то же подключение, те же права, то же
  // расширение vector — иначе репетиция проверяла бы не то окружение.
  const scratch = `bos_restore_check_${Date.now()}`;
  const adminUrl = new URL(source);
  const scratchUrl = new URL(source);
  scratchUrl.pathname = `/${scratch}`;

  console.log(`→ Разворачиваю копию во временную базу ${scratch}`);
  await run("psql", [adminUrl.toString(), "-q", "-c", `CREATE DATABASE "${scratch}"`]);

  try {
    // Без --exit-on-error намеренно: pg_restore ругается на отсутствующие роли
    // и на уже существующие расширения, и это не повод считать копию битой.
    // Настоящую проверку делает сверка строк ниже — она врать не умеет.
    await run("pg_restore", ["--no-owner", "--no-privileges", "--dbname", scratchUrl.toString(), file], {
      stdio: "pipe",
    }).catch((e) => console.warn(`⚠ pg_restore с замечаниями: ${String(e.message).slice(0, 200)}`));

    let mismatch = 0;
    console.log("\n  таблица            исходная  копия");
    for (const table of CHECKED_TABLES) {
      const [a, b] = await Promise.all([
        countRows(source, table).catch(() => -1),
        countRows(scratchUrl.toString(), table).catch(() => -1),
      ]);
      const ok = a === b && a >= 0;
      if (!ok) mismatch += 1;
      console.log(`  ${ok ? "✓" : "✗"} ${table.padEnd(16)} ${String(a).padStart(8)}  ${String(b).padStart(6)}`);
    }

    if (mismatch > 0) {
      console.error(`\n✗ Копия НЕ восстановилась целиком: расходится таблиц — ${mismatch}.`);
      process.exit(1);
    }
    console.log(`\n✓ Восстановление отрепетировано, все таблицы совпали. Файл: ${file}`);
  } finally {
    // Временную базу сносим всегда, даже если сверка упала: иначе на аккаунте
    // копятся базы, а на Neon это ещё и компьют.
    await run("psql", [adminUrl.toString(), "-q", "-c", `DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`])
      .catch(() => console.warn(`⚠ Не удалось снести временную базу ${scratch} — снеси руками.`));
  }
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
