/**
 * Разбор входящего апдейта Telegram — чистая функция без сети и БД, чтобы её
 * можно было покрыть тестами целиком.
 *
 * Главный урок Agentus: не-текстовые сообщения (голос, фото, файл) молча
 * игнорировались, и владелец писал боту в пустоту, не понимая, сломан бот или
 * «просто думает». Теперь каждый распознанный тип получает честный ответ,
 * а по-настоящему служебные апдейты отсеиваются с причиной для логов.
 */

export interface TelegramChat {
  id?: number;
}

export interface TelegramContact {
  phone_number?: string;
  first_name?: string;
}

export interface TelegramIncomingMessage {
  message_id?: number;
  chat?: TelegramChat;
  text?: string;
  /** Подпись к фото/видео/файлу — используем как обычный текст. */
  caption?: string;
  contact?: TelegramContact;
  voice?: unknown;
  audio?: unknown;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  video?: unknown;
  video_note?: unknown;
  sticker?: unknown;
  location?: unknown;
}

/** Один из размеров присланного фото. Telegram отдаёт массив по возрастанию. */
export interface TelegramPhotoSize {
  file_id?: string;
  file_size?: number;
  width?: number;
  height?: number;
}

export interface TelegramDocument {
  file_id?: string;
  file_name?: string;
  file_size?: number;
  mime_type?: string;
}

export interface TelegramCallbackQuery {
  id?: string;
  data?: string;
  message?: { chat?: TelegramChat; message_id?: number };
}

export interface TelegramUpdate {
  update_id?: number;
  message?: TelegramIncomingMessage;
  edited_message?: TelegramIncomingMessage;
  callback_query?: TelegramCallbackQuery;
}

export type UnsupportedMedia =
  | "voice"
  | "photo"
  | "document"
  | "video"
  | "sticker"
  | "location"
  | "other";

export type ParsedUpdate =
  | { kind: "text"; chatId: number; text: string }
  | {
      kind: "document";
      chatId: number;
      fileId: string;
      fileName: string;
      fileSize?: number;
      mimeType?: string;
      caption?: string;
    }
  | {
      kind: "photo";
      chatId: number;
      fileId: string;
      fileSize?: number;
      caption?: string;
    }
  | { kind: "unsupported"; chatId: number; media: UnsupportedMedia }
  | {
      kind: "callback";
      chatId: number;
      callbackId: string;
      messageId?: number;
      data?: string;
    }
  | { kind: "ignored"; reason: string };

/**
 * Обрезка входящего текста. Лимит ниже телеграмного (4096): пересланная
 * простыня не должна раздувать окно контекста и счёт за токены.
 */
const INPUT_TEXT_LIMIT = 4000;

const MEDIA_PROBES: ReadonlyArray<[keyof TelegramIncomingMessage, UnsupportedMedia]> = [
  ["voice", "voice"],
  ["audio", "voice"],
  ["video_note", "video"],
  ["video", "video"],
  ["photo", "photo"],
  ["document", "document"],
  ["sticker", "sticker"],
  ["location", "location"],
];

function detectMedia(message: TelegramIncomingMessage): UnsupportedMedia | null {
  for (const [field, media] of MEDIA_PROBES) {
    const value = message[field];
    if (value !== undefined && value !== null) return media;
  }
  return null;
}

export function parseTelegramUpdate(update: TelegramUpdate): ParsedUpdate {
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message?.chat?.id;
    if (typeof cb.id !== "string" || typeof chatId !== "number") {
      return { kind: "ignored", reason: "callback_query" };
    }
    return {
      kind: "callback",
      chatId,
      callbackId: cb.id,
      messageId: typeof cb.message?.message_id === "number" ? cb.message.message_id : undefined,
      data: typeof cb.data === "string" ? cb.data : undefined,
    };
  }

  // Правки уже отправленных сообщений не обрабатываем: ответ на исходную
  // версию уже ушёл, второй ответ на ту же мысль только путает.
  if (!update.message && update.edited_message) {
    return { kind: "ignored", reason: "edited_message" };
  }

  const message = update.message;
  if (!message) return { kind: "ignored", reason: "no_message" };

  const chatId = message.chat?.id;
  if (typeof chatId !== "number") return { kind: "ignored", reason: "no_chat" };

  const caption = message.caption?.trim() || undefined;

  // Файл и фото разбираются ДО текста. Раньше было наоборот, и вложение с
  // подписью молча исчезало: владелец присылал выписку, подписывал «за март»,
  // бот отвечал на подпись как на обычную реплику, а файл не читал никто.
  // Подпись при этом не теряется — она едет вместе с вложением.
  const document = message.document;
  if (document && typeof document.file_id === "string") {
    return {
      kind: "document",
      chatId,
      fileId: document.file_id,
      // Имя нужно и парсеру (по расширению), и владельцу в ответе. Telegram
      // изредка присылает файл без имени.
      fileName: document.file_name?.trim() || "выписка.csv",
      fileSize: document.file_size,
      mimeType: document.mime_type,
      caption,
    };
  }

  const photo = message.photo;
  if (Array.isArray(photo) && photo.length > 0) {
    // Массив идёт по возрастанию размера — берём последний, самый крупный:
    // на превью текст чека не читается.
    const largest = photo[photo.length - 1];
    if (largest && typeof largest.file_id === "string") {
      return { kind: "photo", chatId, fileId: largest.file_id, fileSize: largest.file_size, caption };
    }
  }

  const text = message.text?.trim() || caption;
  if (text) return { kind: "text", chatId, text: text.slice(0, INPUT_TEXT_LIMIT) };

  const phone = message.contact?.phone_number?.trim();
  if (phone) return { kind: "text", chatId, text: `Мой номер телефона: ${phone}` };

  const media = detectMedia(message);
  if (media) return { kind: "unsupported", chatId, media };

  // Служебные апдейты (вход в группу, закрепление сообщения и т.п.).
  return { kind: "ignored", reason: "service_message" };
}

/** Chat id апдейта — нужен вебхуку для allowlist ещё до полного разбора. */
export function updateChatId(update: TelegramUpdate): number | null {
  const id =
    update.message?.chat?.id ??
    update.edited_message?.chat?.id ??
    update.callback_query?.message?.chat?.id;
  return typeof id === "number" ? id : null;
}

const UNSUPPORTED_REPLIES: Record<UnsupportedMedia, string> = {
  voice:
    "Голосовые пока не понимаю — распознавание речи появится в следующем обновлении. Напишите, пожалуйста, текстом.",
  photo: "Это фото не удалось прочитать — пришлите ещё раз или напишите текстом.",
  document: "Этот файл не удалось принять — пришлите ещё раз или напишите текстом.",
  video: "Видео пока не смотрю — напишите, пожалуйста, текстом, что нужно сделать.",
  sticker: "Стикеры я пока не понимаю. Напишите, пожалуйста, текстом.",
  location: "Геолокацию пока не обрабатываю. Напишите, пожалуйста, текстом.",
  other: "Такие сообщения я пока не понимаю. Напишите, пожалуйста, текстом.",
};

export function unsupportedReply(media: UnsupportedMedia): string {
  return UNSUPPORTED_REPLIES[media];
}
