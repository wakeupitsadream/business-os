import { optionalEnv } from "@/core/env";
import { logError, logWarn } from "@/core/observability/logger";
import { tgApi, tgBase } from "./bot";

/**
 * Скачивание присланных файлов из Telegram.
 *
 * Живёт отдельно от `bot.ts` намеренно: там все вызовы — это POST с JSON-телом
 * и `res.json()` на ответе, а здесь нужен GET с бинарным телом. Попытка
 * переиспользовать `callApi` дала бы либо мусор, либо `null`.
 *
 * Путь скачивания у Telegram ДРУГОЙ, не метод API: файл лежит по
 * `/file/bot<токен>/<file_path>`, а не по `/bot<токен>/<метод>`. Cloudflare
 * Worker раньше форвардил только второе — поэтому в `infra/cloudflare-worker`
 * добавлен маршрут `/file/bot`; без него здесь будет 404 при исправном боте,
 * что выглядит крайне обманчиво.
 */

/**
 * Скачивание идёт дольше отправки сообщения: выписка на медленном канале через
 * прокси в 15 секунд не укладывается. Отдельная константа, а не общая с
 * `SEND_TIMEOUT_MS`, именно поэтому.
 */
const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * Потолок Bot API на скачивание — 20 МБ, и он внешний: превышение даёт
 * невнятную ошибку от Telegram уже после запроса. Проверяем заранее по
 * `file_size` из сообщения, чтобы объяснить владельцу человеческими словами.
 */
export const TELEGRAM_MAX_FILE_BYTES = 20 * 1024 * 1024;

export class TelegramFileError extends Error {
  constructor(
    message: string,
    readonly kind: "too_big" | "not_found" | "network" | "config",
  ) {
    super(message);
    this.name = "TelegramFileError";
  }
}

interface GetFileResult {
  file_path?: string;
  file_size?: number;
}

/**
 * Байты файла по его `file_id`.
 *
 * Два шага, оба обязательны: `getFile` отдаёт временный `file_path` (живёт
 * около часа), и только по нему файл можно забрать.
 */
export async function downloadTelegramFile(
  fileId: string,
  declaredSize?: number,
): Promise<Uint8Array> {
  if (declaredSize !== undefined && declaredSize > TELEGRAM_MAX_FILE_BYTES) {
    throw new TelegramFileError(
      `Файл больше ${Math.floor(TELEGRAM_MAX_FILE_BYTES / 1024 / 1024)} МБ — Telegram не отдаёт такие ботам.`,
      "too_big",
    );
  }

  const token = optionalEnv("TELEGRAM_BOT_TOKEN");
  if (!token) throw new TelegramFileError("Не задан TELEGRAM_BOT_TOKEN", "config");

  const info = await tgApi("getFile", { file_id: fileId });
  const result = (info.ok ? info.data : undefined) as GetFileResult | undefined;
  const filePath = typeof result?.file_path === "string" ? result.file_path : undefined;
  if (!filePath) {
    logWarn("telegram.get_file_failed", { description: info.description });
    throw new TelegramFileError(
      "Telegram не отдал файл — возможно, он слишком старый. Пришлите ещё раз.",
      "not_found",
    );
  }

  // Размер иногда известен только отсюда: у фото в сообщении его может не быть.
  if ((result?.file_size ?? 0) > TELEGRAM_MAX_FILE_BYTES) {
    throw new TelegramFileError("Файл слишком большой для Telegram-бота.", "too_big");
  }

  const url = `${tgBase()}/file/bot${token}/${filePath}`;

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 404 здесь почти всегда означает не «файла нет», а что прокси не знает
      // про путь /file — самая вероятная поломка при первой настройке.
      logError("telegram.file_http_error", { status: res.status });
      throw new TelegramFileError(
        res.status === 404
          ? "Не удалось скачать файл: прокси не пропускает путь /file. Проверьте Cloudflare Worker."
          : `Не удалось скачать файл: Telegram ответил ${res.status}.`,
        "network",
      );
    }

    const buffer = new Uint8Array(await res.arrayBuffer());
    if (buffer.byteLength > TELEGRAM_MAX_FILE_BYTES) {
      throw new TelegramFileError("Файл слишком большой.", "too_big");
    }
    return buffer;
  } catch (e) {
    if (e instanceof TelegramFileError) throw e;
    const message = e instanceof Error ? e.message : String(e);
    logError("telegram.file_download_failed", { error: message });
    throw new TelegramFileError(`Не удалось скачать файл: ${message}`, "network");
  }
}
