/**
 * Гейт для тестов, которые чистят таблицы на настоящем PostgreSQL.
 *
 * Живые проверки (`LIVE_DB=1`) начинаются с `deleteMany` — иначе остатки
 * прошлого прогона ломают сверку с `SELECT SUM`. Но единственным условием
 * запуска была переменная окружения, а базу брал `DATABASE_URL`: какая
 * указана, ту и чистит. Один `.env`, забытый после отладки прода, — и все
 * операции владельца исчезают, а восстановить их неоткуда, потому что
 * резервных копий у системы пока нет.
 *
 * Переменная окружения — это намерение («хочу живые тесты»), а не адрес.
 * Разрешение должно спрашивать про АДРЕС, поэтому здесь белый список, а не
 * чёрный: молча пройти может только заведомо одноразовая база. Чёрный список
 * («не neon.tech») защищал бы ровно до первого другого хостинга.
 *
 * Два способа сказать «эту базу не жалко»:
 *   1. хост петлевой — `localhost`, `127.0.0.1`, `::1`;
 *   2. `DATABASE_URL` совпадает с `TEST_DATABASE_URL` — явное разрешение для
 *      случая, когда одноразовая база всё-таки удалённая (CI, песочница Neon).
 *
 * Всё остальное — отказ. Отказ шумный: тест падает, а не пропускается. Живая
 * проверка, которая молча превратилась в «пропущено», перестала бы ловить
 * расхождения ровно тогда, когда они начались.
 */

export type LiveDbVerdict = { ok: true; how: "loopback" | "test-url" } | { ok: false; reason: string };

/**
 * Ровно две переменные, которые гейт читает. Через индексную сигнатуру, а не
 * интерфейсом с двумя полями: иначе `process.env` (у него своя индексная
 * сигнатура) не подходит под тип.
 */
export type LiveDbEnv = Record<string, string | undefined>;

/** Хосты, на которых база заведомо чужая только по недоразумению. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export class LiveDatabaseRefused extends Error {
  constructor(reason: string) {
    super(
      `Живые тесты отказались работать с этой базой: ${reason}.\n` +
        "Они начинаются с полной очистки таблиц, поэтому запускаются только на " +
        "петлевом хосте (localhost/127.0.0.1) или на базе, явно названной в " +
        "TEST_DATABASE_URL.",
    );
    this.name = "LiveDatabaseRefused";
  }
}

/**
 * Вердикт без побочных эффектов — отдельно от `assert`, чтобы его можно было
 * проверить тестом, не полагаясь на текст исключения.
 *
 * В причине отказа фигурирует только ХОСТ: строка подключения целиком содержит
 * пароль, а причина попадает и в вывод CI.
 */
export function inspectLiveDatabase(env: LiveDbEnv = process.env): LiveDbVerdict {
  const url = env.DATABASE_URL?.trim();
  if (!url) return { ok: false, reason: "DATABASE_URL не задан" };

  const testUrl = env.TEST_DATABASE_URL?.trim();
  if (testUrl && url === testUrl) return { ok: true, how: "test-url" };

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { ok: false, reason: "DATABASE_URL не разбирается как URL" };
  }

  if (LOOPBACK_HOSTS.has(host.toLowerCase())) return { ok: true, how: "loopback" };

  return {
    ok: false,
    reason: `хост «${host}» не петлевой и не равен TEST_DATABASE_URL`,
  };
}

/**
 * Вызывается в `beforeAll`/`beforeEach` ЛЮБОГО теста, который стирает таблицы.
 * За соблюдением следит `live-db.test.ts` — он читает исходники тестов и
 * падает, если `deleteMany` появился в файле без этого гейта.
 */
export function assertDisposableDatabase(env: LiveDbEnv = process.env): void {
  const verdict = inspectLiveDatabase(env);
  if (!verdict.ok) throw new LiveDatabaseRefused(verdict.reason);
}
