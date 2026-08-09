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

/**
 * Узнаваемые НЕ-текстовые форматы.
 *
 * `decodeStatement` по устройству не может отказаться: windows-1251 разбирает
 * любой байт, поэтому PDF «прочитается» как мусор, разберётся в мусорные
 * строки и упрётся в «не тот формат». Из такого сообщения владелец не поймёт
 * ничего: файл-то он прислал правильный, просто не в том виде.
 *
 * Формат определяется по сигнатуре в первых байтах, а не по расширению: имя
 * файла приходит от клиента и врёт регулярно.
 */
export type BinaryFormat = "pdf" | "zip" | "excel";

const SIGNATURES: ReadonlyArray<[BinaryFormat, number[]]> = [
  ["pdf", [0x25, 0x50, 0x44, 0x46]], // %PDF
  ["zip", [0x50, 0x4b, 0x03, 0x04]], // PK.. — сюда же xlsx и docx
  ["excel", [0xd0, 0xcf, 0x11, 0xe0]], // старый .xls
];

export function detectBinaryFormat(bytes: Uint8Array): BinaryFormat | null {
  for (const [format, signature] of SIGNATURES) {
    if (signature.every((byte, i) => bytes[i] === byte)) return format;
  }
  return null;
}

/** Что ответить владельцу: он прислал не тот вид файла, а не сломанный файл. */
export function binaryFormatHint(format: BinaryFormat): string {
  const what =
    format === "pdf"
      ? "PDF"
      : format === "excel"
        ? "файл Excel"
        : "архив или файл Excel";
  return [
    `Это ${what}, а я читаю выписку в CSV.`,
    "",
    "В приложении Т-Банка: Счёт → Выписка → период → формат CSV.",
    "«Справка о движении средств» — это документ для людей, из него цифры",
    "брать нельзя: одна неверно распознанная сумма разойдётся с банком молча.",
  ].join("\n");
}
