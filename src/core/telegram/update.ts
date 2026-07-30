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
  photo?: unknown;
  document?: unknown;
  video?: unknown;
  video_note?: unknown;
  sticker?: unknown;
  location?: unknown;
}

export interface TelegramCallbackQuery {
  id?: string;
  data?: string;
  message?: { chat?: TelegramChat };
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
  | { kind: "unsupported"; chatId: number; media: UnsupportedMedia }
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
  // Нажатия inline-кнопок появятся в Фазе 1 (чек-ины, «Готово» у напоминаний).
  // Сейчас распознаём их отдельно, чтобы в логах было видно, что апдейт дошёл.
  if (update.callback_query) return { kind: "ignored", reason: "callback_query" };

  // Правки уже отправленных сообщений не обрабатываем: ответ на исходную
  // версию уже ушёл, второй ответ на ту же мысль только путает.
  if (!update.message && update.edited_message) {
    return { kind: "ignored", reason: "edited_message" };
  }

  const message = update.message;
  if (!message) return { kind: "ignored", reason: "no_message" };

  const chatId = message.chat?.id;
  if (typeof chatId !== "number") return { kind: "ignored", reason: "no_chat" };

  const text = message.text?.trim() || message.caption?.trim();
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
  photo: "Фото пока не разбираю — распознавание появится позже. Опишите, пожалуйста, текстом.",
  document: "Файлы пока не читаю — эта возможность появится позже. Напишите, пожалуйста, текстом.",
  video: "Видео пока не смотрю — напишите, пожалуйста, текстом, что нужно сделать.",
  sticker: "Стикеры я пока не понимаю. Напишите, пожалуйста, текстом.",
  location: "Геолокацию пока не обрабатываю. Напишите, пожалуйста, текстом.",
  other: "Такие сообщения я пока не понимаю. Напишите, пожалуйста, текстом.",
};

export function unsupportedReply(media: UnsupportedMedia): string {
  return UNSUPPORTED_REPLIES[media];
}
