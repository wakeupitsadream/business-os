import { describe, expect, it } from "vitest";
import { formatPhone, normalizePhone } from "./phone";

/**
 * Нормализация телефона держит дедуп лидов, а дедуп держит доверие к воронке:
 * если один автосервис лежит в базе трижды, владелец звонит человеку три раза.
 * Поэтому все шесть способов записать российский номер обязаны давать одну
 * строку — это и проверяется.
 */

describe("канонический вид", () => {
  it("шесть написаний одного номера дают один ключ", () => {
    const written = [
      "+7 (999) 123-45-67",
      "8 999 123 45 67",
      "89991234567",
      "79991234567",
      "+79991234567",
      "9991234567",
    ];
    const keys = new Set(written.map((w) => normalizePhone(w)));

    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe("79991234567");
  });

  it("мусор вокруг цифр не мешает", () => {
    expect(normalizePhone("тел.: +7 999 123-45-67 (доб. нет)")).toBe("79991234567");
  });
});

describe("отказ вместо догадки", () => {
  it("пусто — это null, а не пустая строка", () => {
    // null занимает уникальный индекс NULL-ом, а он не конфликтует сам с
    // собой: лид без телефона (обычное дело у заявок с сайта) не мешает
    // другому такому же.
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("   ")).toBeNull();
    expect(normalizePhone("не указан")).toBeNull();
  });

  it("огрызок номера не превращается в номер", () => {
    // «8» или «+7» не должны стать ключом: такой «номер» занял бы уникальный
    // индекс и склеил бы двух разных лидов в одного.
    expect(normalizePhone("8")).toBeNull();
    expect(normalizePhone("+7")).toBeNull();
    expect(normalizePhone("12345")).toBeNull();
  });

  it("слишком длинное — тоже отказ", () => {
    expect(normalizePhone("+7 999 123-45-67-89")).toBeNull();
  });

  it("нероссийский код не пускаем в дедуп", () => {
    // Казахстанский начинается с 77 и по длине совпадает с российским.
    expect(normalizePhone("+1 202 555 0143")).toBeNull();
    expect(normalizePhone("+380 44 123 4567")).toBeNull();
  });
});

describe("показ", () => {
  it("канон разворачивается в читаемый вид", () => {
    expect(formatPhone("79991234567")).toBe("+7 999 123-45-67");
  });

  it("ничего не ломает на пустом и странном", () => {
    expect(formatPhone(null)).toBeNull();
    expect(formatPhone("123")).toBe("123");
  });
});
