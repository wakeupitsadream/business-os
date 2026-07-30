/**
 * Нарезка длинного текста под лимит Telegram (4096 символов).
 *
 * Ответ длиннее лимита Telegram отвергает целиком (400 «message is too long»),
 * то есть готовый ответ модели теряется без следа. Поэтому режем сами — и
 * режем по смысловым границам: сначала абзац, потом строка, потом конец
 * предложения, потом пробел, и только в безвыходном случае жёстко по счётчику
 * (длинная ссылка или таблица без пробелов).
 */

export const TELEGRAM_TEXT_LIMIT = 4096;

interface Separator {
  value: string;
  /** Сколько символов разделителя остаётся в конце чанка. */
  keep: number;
}

const SEPARATORS: readonly Separator[] = [
  { value: "\n\n", keep: 0 },
  { value: "\n", keep: 0 },
  { value: ". ", keep: 1 },
  { value: " ", keep: 0 },
];

/**
 * Минимальная заполненность чанка. Без этого порога разделитель, найденный в
 * первых десятках символов, породил бы десятки крошечных сообщений подряд —
 * а Telegram ограничивает частоту отправки в один чат (~1/сек) и начал бы
 * отдавать 429.
 */
const MIN_FILL = 0.5;

function cutIndex(rest: string, limit: number): number {
  const minCut = Math.max(1, Math.floor(limit * MIN_FILL));

  for (const sep of SEPARATORS) {
    // Ищем последнее вхождение, целиком помещающееся в лимит.
    const at = rest.lastIndexOf(sep.value, limit - sep.value.length);
    if (at < 0) continue;
    const cut = at + sep.keep;
    if (cut >= minCut) return cut;
  }

  return limit;
}

export function splitTextForMessenger(text: string, limit: number = TELEGRAM_TEXT_LIMIT): string[] {
  if (limit <= 0) throw new Error("Лимит нарезки должен быть положительным");
  if (text.length === 0) return [];
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > 0) {
    if (rest.length <= limit) {
      chunks.push(rest);
      break;
    }

    const cut = cutIndex(rest, limit);
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }

  // Пустые чанки появляются, когда на границе стояли только пробелы.
  return chunks.filter((chunk) => chunk.length > 0);
}
