import { logWarn } from "@/core/observability/logger";

/**
 * Тарифы моделей для оценки стоимости вызова.
 *
 * Зачем вообще считать: без цены в `LlmUsage` дневной бюджет неотличим от
 * счётчика токенов, а бюджет — единственный тормоз, который не даст агентному
 * циклу за ночь съесть месячный лимит. Точность до рубля не нужна, нужен
 * порядок величины и монотонность.
 *
 * База — прайс провайдера в долларах за 1М токенов; агрегатор (Polza,
 * ProxyAPI) берёт наценку сверху. Курс и наценка вынесены в константы: при
 * скачке курса правится одно число, а не вся таблица.
 */

/** Курс для пересчёта долларового прайса провайдеров в рубли. */
const RUB_PER_USD = 95;
/** Наценка агрегатора поверх прайса провайдера. */
const AGGREGATOR_MARKUP = 1.1;

interface UsdPrice {
  /** $ за 1М входных токенов. */
  in: number;
  /** $ за 1М выходных токенов. */
  out: number;
}

export interface ModelPriceRub {
  /** ₽ за 1М входных токенов (с наценкой агрегатора). */
  inputRub: number;
  /** ₽ за 1М выходных токенов (с наценкой агрегатора). */
  outputRub: number;
}

/**
 * Ключи — нормализованные id БЕЗ namespace провайдера: `anthropic/claude-…`
 * и `claude-…` попадают в одну строку. Обе записи версии (`4.5` и `4-5`)
 * присутствуют намеренно: агрегаторы называют одну и ту же модель по-разному.
 */
const PRICE_TABLE: Record<string, UsdPrice> = {
  // Anthropic
  "claude-opus-4.1": { in: 15, out: 75 },
  "claude-opus-4-1": { in: 15, out: 75 },
  "claude-opus-4": { in: 15, out: 75 },
  "claude-sonnet-4.5": { in: 3, out: 15 },
  "claude-sonnet-4-5": { in: 3, out: 15 },
  "claude-sonnet-4": { in: 3, out: 15 },
  "claude-haiku-4.5": { in: 1, out: 5 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-3-5-haiku": { in: 0.8, out: 4 },
  // OpenAI
  "gpt-4.1": { in: 2, out: 8 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "gpt-4.1-nano": { in: 0.1, out: 0.4 },
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "o4-mini": { in: 1.1, out: 4.4 },
  // Эмбеддинги — выходных токенов нет.
  "text-embedding-3-small": { in: 0.02, out: 0 },
  "text-embedding-3-large": { in: 0.13, out: 0 },
  // Прочее, что реально встречается в каскаде
  "deepseek-chat": { in: 0.27, out: 1.1 },
  "deepseek-reasoner": { in: 0.55, out: 2.19 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "gemini-2.0-flash": { in: 0.1, out: 0.4 },
};

/**
 * Приводит id модели к ключу таблицы: снимает namespace провайдера
 * (`anthropic/claude-sonnet-4.5`), суффикс варианта (`…:free`) и регистр.
 */
export function normalizeModelId(model: string): string {
  const noNamespace = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  const noVariant = noNamespace.split(":")[0] ?? noNamespace;
  return noVariant.trim().toLowerCase();
}

function toRub(price: UsdPrice): ModelPriceRub {
  return {
    inputRub: price.in * RUB_PER_USD * AGGREGATOR_MARKUP,
    outputRub: price.out * RUB_PER_USD * AGGREGATOR_MARKUP,
  };
}

/**
 * Тариф модели или null, если модель незнакома.
 *
 * Если точного совпадения нет, берётся самый длинный ключ-префикс: провайдеры
 * добавляют к id дату снапшота (`gpt-4o-mini-2024-07-18`,
 * `claude-sonnet-4-5-20250929`), и без этого каждая новая ревизия молча
 * обнуляла бы стоимость.
 */
export function modelPriceRub(model: string): ModelPriceRub | null {
  const id = normalizeModelId(model);
  const exact = PRICE_TABLE[id];
  if (exact) return toRub(exact);

  let bestKey: string | null = null;
  for (const key of Object.keys(PRICE_TABLE)) {
    if (!id.startsWith(key)) continue;
    if (bestKey === null || key.length > bestKey.length) bestKey = key;
  }
  if (bestKey === null) return null;
  const price = PRICE_TABLE[bestKey];
  return price ? toRub(price) : null;
}

/** Модели, о которых уже предупредили: иначе warn сыпался бы на каждый вызов. */
const warnedModels = new Set<string>();

/**
 * Тариф для модели, которой нет в таблице: по верхней границе, примерно как у
 * самых дорогих моделей, что мы вообще используем.
 *
 * Раньше здесь возвращался ноль, и это тихо ломало единственный тормоз против
 * разгона расходов: незнакомая модель тратила настоящие деньги, но для дневного
 * лимита не существовала вовсе. Опечатка в имени модели или новинка провайдера
 * — и лимит перестаёт работать ровно тогда, когда он нужнее всего. Завышенная
 * оценка в худшем случае сработает раньше времени: это заметят и допишут тариф.
 */
const UNKNOWN_MODEL_PRICE = { inputRub: 1_500, outputRub: 7_500 };

/**
 * Оценка стоимости вызова в копейках, округление ВВЕРХ (лучше слегка
 * переоценить расход, чем проскочить дневной лимит).
 *
 * Незнакомая модель — не ошибка: вызов проходит, но считается по консервативной
 * верхней оценке, а пробел в тарифах виден по логу `llm.price_unknown`.
 */
export function estimateCostKop(model: string, inputTokens: number, outputTokens: number): number {
  const known = modelPriceRub(model);
  const price = known ?? UNKNOWN_MODEL_PRICE;

  if (!known) {
    const id = normalizeModelId(model);
    if (!warnedModels.has(id)) {
      warnedModels.add(id);
      logWarn("llm.price_unknown", { model, assumed: "верхняя оценка" });
    }
  }

  const inTok = Math.max(0, inputTokens);
  const outTok = Math.max(0, outputTokens);
  const rub = (inTok / 1_000_000) * price.inputRub + (outTok / 1_000_000) * price.outputRub;
  return Math.ceil(rub * 100);
}

/** Для тестов: сбросить память о том, о каких моделях уже предупреждали. */
export function resetPriceWarnings(): void {
  warnedModels.clear();
}
