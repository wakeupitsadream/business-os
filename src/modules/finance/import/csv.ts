/**
 * Разбор CSV.
 *
 * Своя реализация вместо библиотеки. Не из принципа: банковская выписка — это
 * ровно один диалект (кавычки, экранирование удвоением, разделитель `;` или
 * `,`), и он умещается в шестьдесят строк, которые целиком покрыты тестами.
 * Библиотека принесла бы конфигурацию, зависимость и поведение, которое всё
 * равно пришлось бы проверять на живых файлах.
 *
 * Наивный `line.split(";")` здесь не работает совсем: в описании операции
 * регулярно стоит и разделитель, и перевод строки — оба внутри кавычек.
 */

/** Разделители-кандидаты в порядке убывания вероятности для русских банков. */
const CANDIDATES = [";", ",", "\t"] as const;

export type Delimiter = (typeof CANDIDATES)[number];

/**
 * Разделитель определяется по первой строке ВНЕ кавычек: в шапке выписки
 * встречаются заголовки вроде «Сумма, ₽», и запятая внутри них не должна
 * побеждать настоящий `;`.
 */
export function detectDelimiter(text: string): Delimiter {
  const firstLine = readFirstLineOutsideQuotes(text);

  let best: Delimiter = ";";
  let bestCount = 0;
  for (const candidate of CANDIDATES) {
    const count = countOutsideQuotes(firstLine, candidate);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

export function parseCsv(text: string, delimiter: Delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let touched = false; // строка началась — даже если все поля пустые

  const pushField = () => {
    row.push(field.trim());
    field = "";
  };
  const pushRow = () => {
    pushField();
    // Строку из одного пустого поля не считаем строкой: так выглядит хвостовой
    // перевод строки в конце файла, и пустая строка в конце ломала бы счётчики.
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
    touched = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    touched = true;

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // удвоенная кавычка — это одна кавычка в данных
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      pushField();
    } else if (char === "\n") {
      pushRow();
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (touched || field !== "" || row.length > 0) pushRow();
  return rows;
}

function readFirstLineOutsideQuotes(text: string): string {
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') inQuotes = !inQuotes;
    else if (char === "\n" && !inQuotes) return text.slice(0, i);
  }
  return text;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let inQuotes = false;
  let count = 0;
  for (const char of line) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === delimiter && !inQuotes) count += 1;
  }
  return count;
}

/** Заголовок для сопоставления колонок: регистр, ё и пунктуация не важны. */
export function normalizeHeader(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
