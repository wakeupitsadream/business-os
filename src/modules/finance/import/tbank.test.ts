import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";
import { decodeStatement } from "./decode";
import { detectParser } from "./detect";
import { parseTbank } from "./tbank";
import { StatementParseError } from "./types";
import { dayKey } from "@/core/shared/time";

/**
 * Разбор выписки Т-Банка на настоящем файле в cp1251.
 *
 * Фикстура собрана из строк, которые в живой выписке встречаются и ломают
 * наивный парсер: отказ, холд, покупка в валюте, точка с запятой внутри
 * описания, кавычки в названии ООО, операция в час ночи.
 */

const FIXTURE = new URL("./fixtures/tbank-sample.csv", import.meta.url);

function loadFixture() {
  const bytes = new Uint8Array(readFileSync(FIXTURE));
  const { text, encoding } = decodeStatement(bytes);
  return { rows: parseCsv(text), encoding };
}

describe("файл выписки", () => {
  it("читается как cp1251 — иначе описания превращаются в кракозябры", () => {
    const { encoding, rows } = loadFixture();
    expect(encoding).toBe("windows-1251");
    expect(rows[0]?.[0]).toBe("Дата операции");
  });

  it("опознаётся как Т-Банк", () => {
    const { rows } = loadFixture();
    expect(detectParser(rows).parser?.id).toBe("tbank");
  });

  it("чужой заголовок за Т-Банк не принимается", () => {
    expect(detectParser([["date", "amount", "description"]]).parser).toBeNull();
  });
});

describe("разбор строк", () => {
  const result = parseTbank(loadFixture().rows);

  it("расход читается как расход с положительной суммой", () => {
    const fuel = result.rows.find((r) => r.description.includes("Лукойл"));
    expect(fuel?.type).toBe("EXPENSE");
    expect(fuel?.amountKop).toBe(350_000);
    expect(fuel?.mcc).toBe(5541);
  });

  it("доход читается как доход", () => {
    const income = result.rows.find((r) => r.description.includes("Ромашка"));
    expect(income?.type).toBe("INCOME");
    expect(income?.amountKop).toBe(4_000_000);
  });

  it("кавычки в названии контрагента сохраняются", () => {
    const income = result.rows.find((r) => r.description.includes("Ромашка"));
    expect(income?.description).toContain('ООО "Ромашка"');
  });

  it("точка с запятой внутри описания не разрывает строку", () => {
    const taxi = result.rows.find((r) => r.description.includes("Такси"));
    expect(taxi?.description).toBe("Яндекс Такси; ночная поездка");
    expect(taxi?.amountKop).toBe(77_700);
  });

  it("копейки не теряются", () => {
    const cafe = result.rows.find((r) => r.description.includes("Пушкин"));
    expect(cafe?.amountKop).toBe(125_050);
  });

  it("неудавшаяся операция операцией не становится", () => {
    // Иначе расход завышается на все отклонённые попытки оплаты.
    expect(result.rows.some((r) => r.description.includes("Неудачная"))).toBe(false);
    expect(result.skipped.some((s) => s.reason.includes("не прошла"))).toBe(true);
  });

  it("операция в обработке откладывается и считается отдельно", () => {
    // Холд меняет сумму при проведении: импортировать его — значит потом
    // посчитать тот же расход дважды.
    expect(result.rows.some((r) => r.description.includes("в обработке"))).toBe(false);
    expect(result.pending).toBe(1);
  });

  it("покупка в валюте берётся по сумме СПИСАНИЯ в рублях", () => {
    // 15,99 USD списаны как 1 480 ₽. Взять доллары как рубли значит занизить
    // расход в семьдесят раз.
    const github = result.rows.find((r) => r.description.includes("GitHub"));
    expect(github?.amountKop).toBe(148_000);
  });

  it("ночная операция остаётся в своём московском дне", () => {
    // 08.07 01:30 МСК по UTC — это ещё 7 июля. День обязан считаться по
    // владельцу, иначе операция уедет в предыдущий месяц на границе месяцев.
    const taxi = result.rows.find((r) => r.description.includes("Такси"));
    expect(taxi && dayKey(taxi.date)).toBe("2026-07-08");
  });

  it("итогов в файле нет — и парсер об этом говорит прямо", () => {
    // null здесь означает «сверять не с чем», а не «сошлось».
    expect(result.declaredTotals).toBeNull();
  });

  it("считает ровно те строки, что должны были разобраться", () => {
    expect(result.rows).toHaveLength(6);
  });
});

describe("устойчивость к формату", () => {
  const header = ["Дата операции", "Статус", "Сумма операции", "Валюта операции", "Описание"];

  it("перестановка колонок ничего не ломает", () => {
    const shuffled = [
      ["Описание", "Сумма операции", "Дата операции", "Валюта операции"],
      ["Кофе", "-200,00", "05.07.2026", "RUB"],
    ];
    const res = parseTbank(shuffled);
    expect(res.rows[0]?.amountKop).toBe(20_000);
    expect(res.rows[0]?.description).toBe("Кофе");
  });

  it("лишние незнакомые колонки игнорируются", () => {
    const withExtra = [
      [...header, "Округление на инвесткопилку", "Бонусы (руб.)"],
      ["05.07.2026", "OK", "-200,00", "RUB", "Кофе", "0", "0"],
    ];
    expect(parseTbank(withExtra).rows).toHaveLength(1);
  });

  it("нет обязательной колонки — внятная ошибка со списком найденных", () => {
    // Без списка заголовков владелец видит «не тот формат» и не понимает, что
    // именно не так с его файлом.
    const noAmount = [["Дата операции", "Описание"], ["05.07.2026", "Кофе"]];
    expect(() => parseTbank(noAmount)).toThrow(StatementParseError);
    try {
      parseTbank(noAmount);
    } catch (e) {
      expect((e as Error).message).toContain("сумма операции");
      expect((e as Error).message).toContain("Дата операции");
    }
  });

  it("пустой файл не роняет разбор молча", () => {
    expect(() => parseTbank([])).toThrow(StatementParseError);
  });

  it("строка с мусорной суммой попадает в пропуски, а не в операции", () => {
    const broken = [
      ["Дата операции", "Сумма операции", "Валюта операции", "Описание"],
      ["05.07.2026", "-200,00", "RUB", "Кофе"],
      ["06.07.2026", "не число", "RUB", "Странное"],
    ];
    const res = parseTbank(broken);
    expect(res.rows).toHaveLength(1);
    expect(res.skipped[0]?.lineNo).toBe(3);
  });

  it("строка с мусорной датой попадает в пропуски", () => {
    const broken = [
      ["Дата операции", "Сумма операции", "Валюта операции", "Описание"],
      ["вчера", "-200,00", "RUB", "Кофе"],
    ];
    expect(parseTbank(broken).rows).toHaveLength(0);
  });
});
