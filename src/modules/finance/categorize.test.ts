import { describe, expect, it } from "vitest";
import { matchCategoryByAliases, type CategoryOption } from "./categorize";

/**
 * Подбор категории кодом. Это первый и главный уровень: он бесплатный,
 * мгновенный и воспроизводимый, а модель подключается только там, где он
 * промахнулся. Чем больше случаев закрыто здесь, тем дешевле и предсказуемее
 * учёт.
 */

const cat = (
  id: string,
  name: string,
  aliases: string[],
  parentId: string | null = null,
): CategoryOption => ({ id, name, type: "EXPENSE", aliases, parentId });

const OPTIONS: CategoryOption[] = [
  cat("marketing", "Маркетинг", ["маркетинг", "продвижение"]),
  cat("ads", "Реклама", ["реклама", "таргет", "директ", "яндекс директ"], "marketing"),
  cat("transport", "Транспорт", ["бензин", "заправка", "такси", "парковка"], "ops"),
  cat("food", "Питание", ["еда", "обед", "кафе"], "ops"),
  cat("hosting", "Хостинг и серверы", ["хостинг", "сервер", "vps", "домен"], "infra"),
  cat("home", "Дом", ["аренда", "квартира", "дом"], "ops"),
];

describe("подбор по алиасам", () => {
  it("находит категорию в падеже — основной сценарий владельца", () => {
    expect(matchCategoryByAliases("потратил 3500 на бензин", OPTIONS)?.id).toBe("transport");
    expect(matchCategoryByAliases("12к на рекламу", OPTIONS)?.id).toBe("ads");
    expect(matchCategoryByAliases("оплатил хостинг", OPTIONS)?.id).toBe("hosting");
  });

  it("совпадение по названию категории тоже засчитывается", () => {
    const hit = matchCategoryByAliases("расходы на маркетинг", OPTIONS);
    expect(hit?.id).toBe("marketing");
    expect(hit?.via).toBe("name");
  });

  it("длинный алиас побеждает короткий", () => {
    // «яндекс директ» конкретнее просто «директ» — если оба подошли, побеждает
    // тот, что описывает расход точнее.
    const hit = matchCategoryByAliases("оплатил яндекс директ", OPTIONS);
    expect(hit?.matched).toBe("яндекс директ");
  });

  it("при неоднозначности выигрывает более длинный алиас", () => {
    // «еду» стеммится в ту же основу, что «еда», поэтому фраза цепляет обе
    // категории. Разрешает длина: «такси» (5) конкретнее «еда» (3).
    expect(matchCategoryByAliases("еду на такси, 700", OPTIONS)?.id).toBe("transport");
  });

  it("похожие слова не путаются", () => {
    // «домен» — это хостинг, а не «Дом».
    expect(matchCategoryByAliases("продлил домен на год", OPTIONS)?.id).toBe("hosting");
  });

  it("ничего не подошло — возвращает null, а не «Прочее»", () => {
    // Пустая категория видна и вызывает вопрос. «Прочее» выглядит как решение
    // и через полгода собирает треть оборота.
    expect(matchCategoryByAliases("купил подарок жене", OPTIONS)).toBeNull();
  });

  it("пустое описание не даёт совпадений", () => {
    expect(matchCategoryByAliases("   ", OPTIONS)).toBeNull();
  });

  it("пустой справочник не роняет подбор", () => {
    expect(matchCategoryByAliases("бензин", [])).toBeNull();
  });
});
