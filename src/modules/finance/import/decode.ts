/**
 * Определение кодировки банковской выписки.
 *
 * Т-Банк отдаёт CSV в cp1251 — это не редкость, а норма для российских банков.
 * Прочитать такой файл как UTF-8 значит получить «ÀÇÑ Ëóêîéë» в описаниях и
 * категории, подобранные по кракозябрам.
 *
 * Зависимость не нужна: Node здесь собран с полным ICU, и
 * `new TextDecoder("windows-1251")` работает из коробки.
 */

export type StatementEncoding = "utf-8" | "windows-1251";

export interface DecodedFile {
  text: string;
  encoding: StatementEncoding;
  /** true — кодировку выбрали по BOM, а не угадали по содержимому. */
  certain: boolean;
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];

/**
 * Порядок проверок: BOM → строгий UTF-8 → cp1251.
 *
 * Строгий режим (`fatal: true`) здесь ключевой. Обычный `TextDecoder` молча
 * заменяет неразбираемые байты на U+FFFD, то есть cp1251-файл «прочитается»
 * без единой ошибки — просто мусором. Единственный способ отличить один
 * однобайтовый текст от другого — потребовать, чтобы UTF-8 разобрался целиком.
 *
 * Обратное направление ошибиться не может: любой валидный UTF-8 остаётся
 * валидным UTF-8, так что до cp1251 доходят только файлы, которые UTF-8 быть
 * не могут.
 */
export function decodeStatement(bytes: Uint8Array): DecodedFile {
  if (hasUtf8Bom(bytes)) {
    const text = new TextDecoder("utf-8").decode(bytes.subarray(UTF8_BOM.length));
    return { text, encoding: "utf-8", certain: true };
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text, encoding: "utf-8", certain: false };
  } catch {
    // Windows-1251 разбирает любой байт, поэтому исключения здесь не будет
    // никогда — но это и означает «последняя попытка», а не «точно угадали».
    const text = new TextDecoder("windows-1251").decode(bytes);
    return { text, encoding: "windows-1251", certain: false };
  }
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return UTF8_BOM.every((byte, i) => bytes[i] === byte);
}
