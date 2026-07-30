import { normalizeHeader } from "./csv";
import { tbankParser } from "./tbank";
import type { BankStatementParser } from "./types";

/**
 * Реестр парсеров выписок.
 *
 * Реестр, а не цепочка `if`, потому что банк владелец сменит раньше, чем через
 * год: сейчас Т-Банк, дальше возможна Точка. Добавление банка должно быть
 * новым файлом и одной строкой здесь, а не правкой общего кода разбора.
 */

export const PARSERS: BankStatementParser[] = [tbankParser];

export interface Detection {
  parser: BankStatementParser | null;
  /** Нормализованные заголовки — они же уходят в подбор карты колонок. */
  headers: string[];
}

export function detectParser(rows: string[][]): Detection {
  const header = rows[0] ?? [];
  const headers = header.map(normalizeHeader);

  const parser = PARSERS.find((p) => p.matches(headers)) ?? null;
  return { parser, headers };
}

export function parserById(id: string): BankStatementParser | undefined {
  return PARSERS.find((p) => p.id === id);
}
