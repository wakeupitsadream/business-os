import { beforeEach, describe, expect, it } from "vitest";
import { estimateCostKop, modelPriceRub, normalizeModelId, resetPriceWarnings } from "./pricing";

beforeEach(() => {
  resetPriceWarnings();
});

describe("normalizeModelId", () => {
  it("снимает namespace провайдера", () => {
    expect(normalizeModelId("anthropic/claude-sonnet-4.5")).toBe("claude-sonnet-4.5");
    expect(normalizeModelId("gpt-4o-mini")).toBe("gpt-4o-mini");
  });

  it("снимает суффикс варианта и регистр", () => {
    expect(normalizeModelId("DeepSeek/DeepSeek-Chat:free")).toBe("deepseek-chat");
  });
});

describe("modelPriceRub", () => {
  it("одна цена независимо от namespace шлюза", () => {
    expect(modelPriceRub("openai/gpt-4o-mini")).toEqual(modelPriceRub("gpt-4o-mini"));
  });

  it("выход дороже входа у чат-моделей", () => {
    const price = modelPriceRub("anthropic/claude-sonnet-4.5");
    expect(price).not.toBeNull();
    expect(price!.outputRub).toBeGreaterThan(price!.inputRub);
  });

  it("opus дороже sonnet, sonnet дороже cheap-модели", () => {
    const opus = modelPriceRub("anthropic/claude-opus-4.1")!;
    const sonnet = modelPriceRub("anthropic/claude-sonnet-4.5")!;
    const mini = modelPriceRub("openai/gpt-4o-mini")!;
    expect(opus.inputRub).toBeGreaterThan(sonnet.inputRub);
    expect(sonnet.inputRub).toBeGreaterThan(mini.inputRub);
  });

  it("датированный снапшот модели не теряет тариф", () => {
    expect(modelPriceRub("gpt-4o-mini-2024-07-18")).toEqual(modelPriceRub("gpt-4o-mini"));
    expect(modelPriceRub("anthropic/claude-sonnet-4-5-20250929")).toEqual(
      modelPriceRub("claude-sonnet-4.5"),
    );
  });

  it("префиксное совпадение берёт самый длинный ключ", () => {
    // «gpt-4o» тоже префикс, но модель — именно mini и она дешевле.
    const dated = modelPriceRub("gpt-4o-mini-2024-07-18")!;
    const big = modelPriceRub("gpt-4o")!;
    expect(dated.inputRub).toBeLessThan(big.inputRub);
  });

  it("незнакомая модель — null", () => {
    expect(modelPriceRub("совершенно/неизвестная-модель")).toBeNull();
  });

  it("у эмбеддингов нет выходной цены", () => {
    expect(modelPriceRub("text-embedding-3-small")!.outputRub).toBe(0);
  });
});

describe("estimateCostKop", () => {
  it("нулевые токены — нулевая стоимость", () => {
    expect(estimateCostKop("openai/gpt-4o-mini", 0, 0)).toBe(0);
  });

  it("округляет вверх: копеечный расход не теряется", () => {
    // 100 входных токенов gpt-4o-mini — доли копейки; округление вниз дало бы
    // ноль, и дневной бюджет никогда бы не набрался из мелких вызовов.
    const cost = estimateCostKop("openai/gpt-4o-mini", 100, 0);
    expect(cost).toBe(1);
    expect(Number.isInteger(cost)).toBe(true);
  });

  it("миллион входных токенов sonnet — сотни рублей", () => {
    const kop = estimateCostKop("anthropic/claude-sonnet-4.5", 1_000_000, 0);
    expect(kop).toBeGreaterThan(200 * 100);
    expect(kop).toBeLessThan(400 * 100);
  });

  it("выходные токены учитываются отдельно и дороже", () => {
    const input = estimateCostKop("anthropic/claude-sonnet-4.5", 100_000, 0);
    const output = estimateCostKop("anthropic/claude-sonnet-4.5", 0, 100_000);
    expect(output).toBeGreaterThan(input);
  });

  it("стоимость монотонна по числу токенов", () => {
    const small = estimateCostKop("openai/gpt-4o-mini", 10_000, 1_000);
    const big = estimateCostKop("openai/gpt-4o-mini", 100_000, 10_000);
    expect(big).toBeGreaterThan(small);
  });

  it("незнакомая модель не роняет вызов и считается по верхней оценке", () => {
    // Не ноль: иначе дневной лимит расходов перестаёт видеть такие вызовы.
    expect(estimateCostKop("нечто/непонятное", 1_000_000, 1_000_000)).toBeGreaterThan(0);
  });

  it("отрицательные токены не дают отрицательной стоимости", () => {
    expect(estimateCostKop("openai/gpt-4o-mini", -100, -100)).toBe(0);
  });
});

describe("незнакомая модель не выключает дневной лимит", () => {
  beforeEach(() => resetPriceWarnings());

  it("оценивается дороже нуля — иначе лимит её не видит", () => {
    // Ноль означал бы: модель тратит настоящие деньги, но для лимита расходов
    // не существует. Опечатка в имени выключала бы единственный тормоз.
    expect(estimateCostKop("совершенно-неизвестная-модель", 1_000_000, 100_000)).toBeGreaterThan(0);
  });

  it("оценивается не дешевле самой дорогой известной модели", () => {
    const unknown = estimateCostKop("несуществующая/модель-9000", 1_000_000, 1_000_000);
    const known = estimateCostKop("openai/gpt-4o-mini", 1_000_000, 1_000_000);
    expect(unknown).toBeGreaterThanOrEqual(known);
  });

  it("предупреждение об отсутствии тарифа не мешает счёту", () => {
    const first = estimateCostKop("неизвестная-модель-X", 500_000, 50_000);
    const second = estimateCostKop("неизвестная-модель-X", 500_000, 50_000);
    expect(second).toBe(first);
  });
});
