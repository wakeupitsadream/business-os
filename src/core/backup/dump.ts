import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";

/**
 * Снятие дампа базы через `pg_dump`.
 *
 * Формат — обычный SQL (plain), а не custom. Причина в том, кто и когда будет
 * восстанавливаться: владелец, один, в плохой день. Plain-дамп читается
 * глазами, проверяется головой и восстанавливается одной командой
 * `psql < файл` куда угодно — без pg_restore и его флагов. Для базы в
 * десяток мегабайт цена формата — ноль.
 *
 * Подключение — ТОЛЬКО по прямой строке (DIRECT_URL, без `-pooler`):
 * pg_dump берёт блокировки и держит длинную сессию, чего PgBouncer в
 * transaction-режиме не переживает — тот же урок, что с миграциями.
 *
 * Версии: pg_dump обязан быть НЕ СТАРШЕ мажорной версии сервера, иначе он
 * откажется с «server version mismatch». В образ ставится самый свежий клиент
 * из репозитория Alpine (см. Dockerfile); если Neon однажды обновится выше —
 * ошибка всплывёт в ночной тревоге с этим самым текстом, лечится обновлением
 * образа.
 */

/** Дамп ~10 МБ снимается секундами; две минуты — уже «что-то не так». */
const DUMP_TIMEOUT_MS = 120_000;

/** Хвост stderr для сообщения об ошибке: целиком он никому не нужен. */
const STDERR_TAIL = 600;

export class BackupError extends Error {
  constructor(
    message: string,
    readonly kind: "spawn" | "exit" | "timeout" | "empty",
  ) {
    super(message);
    this.name = "BackupError";
  }
}

export interface DumpResult {
  /** Сжатый дамп — то, что уезжает файлом. */
  gz: Uint8Array;
  rawBytes: number;
  gzBytes: number;
}

export async function dumpDatabase(url: string): Promise<DumpResult> {
  const raw = await runPgDump(url);

  // Пустой или оборванный дамп хуже отсутствующего: он выглядит как копия,
  // но восстановить из него нечего. Проверяем маркеры формата pg_dump —
  // заголовок и хотя бы одну таблицу.
  const head = raw.subarray(0, 4096).toString("utf8");
  if (
    raw.byteLength < 1024 ||
    !head.includes("PostgreSQL database dump") ||
    !raw.includes("CREATE TABLE")
  ) {
    throw new BackupError("дамп выглядит пустым или оборванным — не отправляю", "empty");
  }

  const gz = gzipSync(raw);
  return { gz, rawBytes: raw.byteLength, gzBytes: gz.byteLength };
}

function runPgDump(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // URL передаётся аргументом и НИКОГДА не логируется: в нём пароль.
    // pg_dump сам пароль в stderr не печатает, но страховка ниже (scrub)
    // вырезает строку целиком, если она вдруг всплывёт в сообщении.
    const child = spawn(
      "pg_dump",
      [`--dbname=${url}`, "--no-owner", "--no-privileges", "--encoding=UTF8"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const out: Buffer[] = [];
    let errTail = "";
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new BackupError(`pg_dump не уложился в ${DUMP_TIMEOUT_MS / 1000} с`, "timeout"));
    }, DUMP_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      errTail = (errTail + String(chunk)).slice(-STDERR_TAIL);
    });

    child.on("error", (e) => {
      // ENOENT — самый вероятный случай: клиент не установлен в образ.
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new BackupError(`pg_dump не запустился: ${e.message}`, "spawn"));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new BackupError(`pg_dump завершился с кодом ${code}: ${scrub(errTail, url)}`, "exit"));
      } else {
        resolve(Buffer.concat(out));
      }
    });
  });
}

function scrub(text: string, secret: string): string {
  return text.split(secret).join("<строка подключения>").trim();
}
