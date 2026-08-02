import { envInt, optionalEnv } from "@/core/env";
import { logInfo } from "@/core/observability/logger";
import { assertCanRequest } from "./throttle";
import {
  ConnectorError,
  type ConnectorLimits,
  type LeadConnector,
  type ParsedCompany,
  type SearchQuery,
  type SearchResult,
} from "./types";

/**
 * Яндекс Geosearch API — официальный поиск организаций.
 *
 * Выбран первым источником, потому что у него есть бесплатный тир и он
 * легален: скрапинг выдачи Яндекса запрещён пользовательским соглашением, и
 * воронка, построенная на нём, ставит под удар сам бизнес.
 *
 * **Ключ уходит в query string, и это опасно.** У Geosearch нет заголовочной
 * авторизации — `apikey` только параметром. Значит, URL нельзя писать ни в
 * логи, ни в текст ошибки: прокси, панель хостинга и разбор инцидента увидят
 * ключ. Поэтому наружу отсюда уходит только путь без параметров, а `redact`
 * ниже вырезает ключ из всего, что попадает в сообщение об ошибке.
 */

const BASE_URL = "https://search-maps.yandex.ru/v1/";
const TIMEOUT_MS = 15_000;
/** Потолок выдачи Geosearch на один запрос. */
const MAX_PAGE_SIZE = 50;

/**
 * Кап ниже реального лимита бесплатного тира (1000/сутки) намеренно: наш день
 * считается по UTC, провайдер сбрасывает счётчик по своему времени, и запас
 * закрывает расхождение. Переопределяется переменной, если тариф изменится.
 */
const DEFAULT_DAILY_CAP = 800;
const DEFAULT_PER_MINUTE = 20;

function apiKey(): string | undefined {
  return optionalEnv("YANDEX_GEO_API_KEY");
}

/** Вырезать ключ из любого текста, который может уехать в лог. */
export function redactKey(text: string, key = apiKey()): string {
  if (!key) return text;
  return text.split(key).join("<ключ>");
}

interface GeoFeature {
  properties?: {
    name?: string;
    description?: string;
    CompanyMetaData?: {
      id?: string;
      name?: string;
      address?: string;
      url?: string;
      Phones?: Array<{ formatted?: string; type?: string }>;
      Categories?: Array<{ name?: string; class?: string }>;
      Rating?: { score?: number; reviews?: number };
    };
  };
}

export const yandexGeoConnector: LeadConnector = {
  id: "yandex_geo",
  label: "Яндекс Geosearch",

  get limits(): ConnectorLimits {
    return {
      requestsPerMinute: Math.max(1, envInt("YANDEX_GEO_PER_MINUTE", DEFAULT_PER_MINUTE)),
      dailyCap: Math.max(1, envInt("YANDEX_GEO_DAILY_CAP", DEFAULT_DAILY_CAP)),
    };
  },

  isConfigured(): boolean {
    return Boolean(apiKey());
  },

  async search(query: SearchQuery): Promise<SearchResult> {
    const key = apiKey();
    if (!key) {
      throw new ConnectorError(
        "Не задан YANDEX_GEO_API_KEY — источник недоступен.",
        "config",
      );
    }

    // Бронь ДО запроса: см. throttle.ts. Провайдер списывает квоту и за
    // неудачный запрос, поэтому считаем попытку, а не успех.
    await assertCanRequest(yandexGeoConnector.id, yandexGeoConnector.limits);

    const pageSize = Math.min(query.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
    const skip = typeof query.cursor?.skip === "number" ? query.cursor.skip : 0;

    const url = new URL(BASE_URL);
    url.searchParams.set("apikey", key);
    url.searchParams.set("text", `${query.rubric} ${query.city}`);
    url.searchParams.set("type", "biz");
    url.searchParams.set("lang", "ru_RU");
    url.searchParams.set("results", String(pageSize));
    if (skip > 0) url.searchParams.set("skip", String(skip));

    const body = await request(url);
    const features = Array.isArray((body as { features?: unknown }).features)
      ? ((body as { features: GeoFeature[] }).features ?? [])
      : [];

    const companies = features
      .map((f) => toCompany(f, query.city))
      .filter((c): c is ParsedCompany => c !== null);

    // Пагинация курсором по смещению: джоба резюмируема, и после
    // перезапуска контейнера мы не жжём квоту на уже полученное.
    const nextCursor = features.length < pageSize ? null : { skip: skip + features.length };

    logInfo("sales.connector_page", {
      connector: yandexGeoConnector.id,
      rubric: query.rubric,
      city: query.city,
      got: companies.length,
      skip,
    });

    return { companies, nextCursor, requestsUsed: 1 };
  },
};

async function request(url: URL): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (res.status === 403) {
      throw new ConnectorError("Яндекс отклонил ключ: проверьте YANDEX_GEO_API_KEY", "config");
    }
    if (res.status === 429) {
      throw new ConnectorError("Яндекс ограничил частоту запросов — попробуем позже", "quota");
    }
    if (!res.ok) {
      // Только статус: тело ответа Яндекса может содержать эхо запроса вместе
      // с ключом.
      throw new ConnectorError(`Яндекс ответил ${res.status}`, "http");
    }

    return await res.json();
  } catch (e) {
    if (e instanceof ConnectorError) throw e;
    const message = e instanceof Error ? e.message : String(e);
    // Сообщение об ошибке fetch содержит URL целиком — то есть ключ.
    throw new ConnectorError(`Не удалось получить выдачу: ${redactKey(message)}`, "network");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Разбор одной организации.
 *
 * Возвращает `null`, если нет идентификатора или названия: запись без них
 * невозможно ни дедуплицировать, ни показать владельцу, а «Без названия» в
 * списке кандидатов — это мусор, который придётся разбирать руками.
 */
export function toCompany(feature: GeoFeature, fallbackCity: string): ParsedCompany | null {
  const meta = feature.properties?.CompanyMetaData;
  const externalId = meta?.id?.trim();
  const name = (meta?.name ?? feature.properties?.name)?.trim();
  if (!externalId || !name) return null;

  const phones = (meta?.Phones ?? [])
    .map((p) => p.formatted?.trim())
    .filter((p): p is string => Boolean(p));

  const categories = (meta?.Categories ?? []).map((c) => (c.name ?? "").toLowerCase());
  const niche = detectNiche(categories, name);

  return {
    externalId,
    source: "yandex_geo",
    name,
    niche,
    city: fallbackCity || null,
    address: meta?.address?.trim() || null,
    phones,
    site: meta?.url?.trim() || null,
    rating: typeof meta?.Rating?.score === "number" ? meta.Rating.score : null,
    reviewsCount: typeof meta?.Rating?.reviews === "number" ? meta.Rating.reviews : null,
    // Организация из справочника — юрлицо или ИП по месту деятельности. Это
    // не персональные данные физлица, и помечать их так значило бы обесценить
    // пометку там, где она действительно нужна (частные мастера с Avito).
    isPersonalData: false,
    raw: feature,
  };
}

/** Ниша по категориям справочника. Всё непонятное — OTHER, а не догадка. */
function detectNiche(categories: string[], name: string): ParsedCompany["niche"] {
  const haystack = [...categories, name.toLowerCase()].join(" ");
  if (/автосервис|автосерв|шиномонтаж|автомойк|сто\b|ремонт авто/.test(haystack)) {
    return "AUTO_SERVICE";
  }
  return "OTHER";
}
