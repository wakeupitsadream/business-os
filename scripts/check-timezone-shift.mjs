#!/usr/bin/env node
/**
 * Что смена пояса владельца сделала с уже записанными операциями.
 *
 * Миграция `00000000000008` поменяла пояс с Москвы на Екатеринбург, но денежных
 * данных не касалась — и не должна была: в базе лежит UTC, он от пояса не
 * зависит. Меняется ДРУГОЕ, и это незаметно:
 *
 *   1. **Принадлежность месяцу.** Границы периодов режутся по поясу владельца.
 *      Операция в 20:00 UTC 30 июня по Москве (UTC+3) — ещё июньская, по
 *      Екатеринбургу (UTC+5) — уже июльская. Такие операции переехали из месяца
 *      в месяц, и месячные итоги за прошлые периоды изменились.
 *
 *   2. **Ключи дедупа импорта.** В ключ входит ДЕНЬ по поясу владельца. У строк,
 *      импортированных до смены пояса, ключи посчитаны по Москве. Повторная
 *      загрузка пересекающегося периода посчитает их по Екатеринбургу, не
 *      найдёт совпадения и запишет те же операции второй раз.
 *
 * Скрипт ничего не меняет. Он отвечает на один вопрос: есть ли вообще такие
 * строки и сколько их. Дальше решает владелец — если это тестовые данные,
 * проще снести; если настоящие, нужна отдельная миграция.
 *
 * Запуск:  DIRECT_URL="<прямая строка>" node scripts/check-timezone-shift.mjs
 */

import { PrismaClient } from "@prisma/client";

/** Дата коммита, сменившего пояс (`0012f90`). */
const TZ_SWITCH = "2026-07-30T00:00:00Z";
const OLD_TZ = "Europe/Moscow";
const NEW_TZ = "Asia/Yekaterinburg";

const url = process.env.DIRECT_URL?.trim() || process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("✗ Не задан DIRECT_URL (или DATABASE_URL).");
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url } }, log: [] });

try {
  const [{ total }] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS total FROM "Transaction" WHERE "createdAt" < $1`,
    new Date(TZ_SWITCH),
  );

  if (total === 0) {
    console.log("✓ Операций, записанных до смены пояса, нет — делать нечего.");
    process.exit(0);
  }

  // Месяц по старому и по новому поясу считает сама база: так не нужно
  // повторять здесь логику dayBounds и рисковать разойтись с ней.
  //
  // Двойное `AT TIME ZONE` обязательно. Колонка `date` — это `timestamp WITHOUT
  // time zone`, и одиночное `AT TIME ZONE 'Europe/Moscow'` не переводит её в
  // Москву, а ТРАКТУЕТ как московскую — то есть даёт сдвиг в другую сторону и
  // молча отвечает «ничего не сменило месяц». Сначала объявляем время
  // UTC (оно там и есть), потом переводим в нужный пояс.
  const moved = await prisma.$queryRawUnsafe(
    `SELECT
       to_char(date AT TIME ZONE 'UTC' AT TIME ZONE $2, 'YYYY-MM') AS old_month,
       to_char(date AT TIME ZONE 'UTC' AT TIME ZONE $3, 'YYYY-MM') AS new_month,
       count(*)::int AS n,
       sum("amountKop")::bigint AS kop
     FROM "Transaction"
     WHERE "createdAt" < $1
       AND to_char(date AT TIME ZONE 'UTC' AT TIME ZONE $2, 'YYYY-MM')
         <> to_char(date AT TIME ZONE 'UTC' AT TIME ZONE $3, 'YYYY-MM')
     GROUP BY 1, 2
     ORDER BY 1`,
    new Date(TZ_SWITCH),
    OLD_TZ,
    NEW_TZ,
  );

  const [{ keyed }] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS keyed FROM "Transaction"
     WHERE "createdAt" < $1 AND "dedupKey" IS NOT NULL`,
    new Date(TZ_SWITCH),
  );

  console.log(`Операций записано до смены пояса: ${total}`);
  console.log(`Из них с ключом дедупа импорта:  ${keyed}`);

  if (moved.length === 0) {
    console.log("\n✓ Ни одна операция не сменила месяц: все они далеко от полуночи.");
  } else {
    console.log("\n⚠ Сменили месяц (итоги за эти периоды изменились):");
    for (const r of moved) {
      console.log(`   ${r.old_month} → ${r.new_month}: ${r.n} шт, ${(Number(r.kop) / 100).toFixed(2)} ₽`);
    }
  }

  if (keyed > 0) {
    console.log(
      "\n⚠ У этих строк ключи дедупа посчитаны по Москве. Повторная загрузка\n" +
        "   пересекающегося периода их не узнает и запишет операции второй раз.",
    );
  }

  console.log(
    "\nЧто дальше. Если это тестовые данные — снести их и импортировать заново,\n" +
      "это дешевле любой миграции. Если настоящие — нужна отдельная миграция,\n" +
      "и делать её надо ДО следующего импорта пересекающегося периода.",
  );
} finally {
  await prisma.$disconnect();
}
