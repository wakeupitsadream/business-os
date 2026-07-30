import { describe, expect, it } from "vitest";
import {
  acquiringRate,
  categoryTrends,
  concentration,
  expenseAnomaly,
  profitFact,
  runwayFact,
} from "./facts";
import type { CategoryTotal } from "../query";
import type { MonthPoint } from "../metrics";

/**
 * Слой фактов. Это единственный источник чисел для инсайтов, поэтому здесь
 * важнее всего не «находит ли он тренды», а НЕ находит ли он их там, где их
 * нет: инсайт про рост расходов на кофе с 200 до 600 ₽ обесценивает всю ленту.
 */

const cat = (id: string, name: string, amountKop: number): CategoryTotal => ({
  categoryId: id,
  categoryName: name,
  amountKop,
  count: 1,
});

const month = (expenseKop: number, incomeKop = 0): MonthPoint => ({
  key: "2026-07",
  label: "июл",
  incomeKop,
  expenseKop,
  profitKop: incomeKop - expenseKop,
});

describe("тренды по категориям", () => {
  it("находит существенный рост", () => {
    const facts = categoryTrends(
      [cat("ads", "Реклама", 30_000_00)],
      [cat("ads", "Реклама", 10_000_00)],
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]?.text).toContain("вырос");
    expect(facts[0]?.data.percent).toBe(200);
  });

  it("находит существенное снижение", () => {
    const facts = categoryTrends(
      [cat("ads", "Реклама", 10_000_00)],
      [cat("ads", "Реклама", 30_000_00)],
    );
    expect(facts[0]?.text).toContain("снизился");
  });

  it("копеечный рост в процентах трендом не считается", () => {
    // 200 → 600 ₽ это +200%, и это не новость. Проценты без абсолютных сумм
    // врут, поэтому порог двойной.
    expect(categoryTrends([cat("food", "Питание", 600_00)], [cat("food", "Питание", 200_00)]))
      .toHaveLength(0);
  });

  it("крупное, но малое в процентах изменение трендом не считается", () => {
    expect(
      categoryTrends([cat("ads", "Реклама", 105_000_00)], [cat("ads", "Реклама", 100_000_00)]),
    ).toHaveLength(0);
  });

  it("появление статьи с нуля — не «рост на бесконечность»", () => {
    const facts = categoryTrends([cat("team", "Команда", 50_000_00)], []);
    expect(facts[0]?.text).toContain("Появилась новая статья");
    expect(facts[0]?.data.previousKop).toBe(0);
  });

  it("без изменений фактов нет", () => {
    const same = [cat("ads", "Реклама", 30_000_00)];
    expect(categoryTrends(same, same)).toHaveLength(0);
  });
});

describe("аномалия расходов", () => {
  it("выброс выше среднего плюс два сигмы находится", () => {
    const series = [month(100_000_00), month(105_000_00), month(95_000_00), month(400_000_00)];
    const fact = expenseAnomaly(series);
    expect(fact?.kind).toBe("anomaly");
    expect(fact?.data.amountKop).toBe(400_000_00);
  });

  it("обычный месяц аномалией не считается", () => {
    const series = [month(100_000_00), month(105_000_00), month(95_000_00), month(102_000_00)];
    expect(expenseAnomaly(series)).toBeNull();
  });

  it("на короткой истории не гадает", () => {
    // Три месяца — слишком мало, чтобы отклонение что-то значило.
    expect(expenseAnomaly([month(100_000_00), month(500_000_00)])).toBeNull();
  });

  it("пустая история не даёт деления на ноль", () => {
    expect(expenseAnomaly([month(0), month(0), month(0), month(0)])).toBeNull();
  });
});

describe("концентрация расходов", () => {
  it("находит перекос", () => {
    const fact = concentration([
      cat("a", "Реклама", 50_000_00),
      cat("b", "Команда", 30_000_00),
      cat("c", "Хостинг", 10_000_00),
      cat("d", "Прочее", 5_000_00),
    ]);
    // 90 000 из 95 000 — 94,7%, округляется до 95.
    expect(fact?.data.sharePercent).toBe(95);
  });

  it("равномерные расходы наблюдением не считаются", () => {
    const even = Array.from({ length: 10 }, (_, i) => cat(`c${i}`, `К${i}`, 10_000_00));
    expect(concentration(even)).toBeNull();
  });

  it("меньше трёх категорий — не о чем говорить", () => {
    expect(concentration([cat("a", "Реклама", 50_000_00)])).toBeNull();
  });
});

describe("runway", () => {
  it("прибыльный бизнес факта не даёт", () => {
    expect(runwayFact(null, null)).toBeNull();
  });

  it("сокращение запаса отмечается отдельно", () => {
    const fact = runwayFact(2.0, 4.0);
    expect(fact?.text).toContain("сокращается");
  });

  it("короткий запас весит больше длинного", () => {
    const short = runwayFact(2, null);
    const long = runwayFact(12, null);
    expect((short?.weight ?? 0) > (long?.weight ?? 0)).toBe(true);
  });
});

describe("эквайринг", () => {
  it("считает эффективную ставку", () => {
    const fact = acquiringRate(1_000_000_00, 35_000_00);
    expect(fact?.data.ratePercent).toBe(3.5);
  });

  it("без комиссии факта нет", () => {
    expect(acquiringRate(1_000_000_00, 0)).toBeNull();
  });
});

describe("прибыль", () => {
  it("убыток называется убытком", () => {
    const fact = profitFact(-50_000_00, 10_000_00);
    expect(fact?.text).toContain("убыток");
  });

  it("убыток важнее прибыли", () => {
    const loss = profitFact(-50_000_00, 0);
    const gain = profitFact(50_000_00, 0);
    expect((loss?.weight ?? 0) > (gain?.weight ?? 0)).toBe(true);
  });

  it("пустой месяц наблюдением не считается", () => {
    expect(profitFact(0, 0)).toBeNull();
  });
});
