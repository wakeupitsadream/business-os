import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Разбор выдачи и защита ключа.
 *
 * Ключ Geosearch уходит в query string — заголовочной авторизации у API нет.
 * Значит, единственная защита от его утечки в логи и в текст ошибки — это то,
 * что здесь проверяется. Молчаливая регрессия тут стоит ключа.
 */

const reserve = vi.fn(async () => undefined);
vi.mock("./throttle", () => ({
  assertCanRequest: () => reserve(),
  reserveRequest: async () => ({ allowed: true, retryAfterSec: 0, dailyRemaining: 99 }),
  resetMinuteWindow: () => {},
  usedToday: async () => 0,
  utcDayKey: () => "2026-08-02",
}));

const { yandexGeoConnector, toCompany, redactKey } = await import("./yandex-geo");
const { stubConnector } = await import("./stub");
const { configuredConnectors, defaultConnector, connectorById } = await import("./index");
const { ConnectorError } = await import("./types");

const KEY = "secret-geo-key-123";

function feature(over: Record<string, unknown> = {}) {
  return {
    properties: {
      CompanyMetaData: {
        id: "1234567890",
        name: "Автосервис на Ленина",
        address: "Екатеринбург, Ленина, 1",
        url: "https://example.ru",
        Phones: [{ formatted: "+7 (999) 123-45-67", type: "phone" }],
        Categories: [{ name: "Автосервис, автотехцентр" }],
        Rating: { score: 4.6, reviews: 128 },
        ...over,
      },
    },
  };
}

beforeEach(() => {
  reserve.mockReset();
  reserve.mockResolvedValue(undefined);
  delete process.env.YANDEX_GEO_API_KEY;
  delete process.env.SALES_STUB_CONNECTOR;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.YANDEX_GEO_API_KEY;
  delete process.env.SALES_STUB_CONNECTOR;
});

describe("защита ключа", () => {
  it("ключ вырезается из текста ошибки", () => {
    const raw = `fetch failed for https://search-maps.yandex.ru/v1/?apikey=${KEY}&text=x`;
    expect(redactKey(raw, KEY)).not.toContain(KEY);
    expect(redactKey(raw, KEY)).toContain("<ключ>");
  });

  it("сетевая ошибка не выносит ключ наружу", async () => {
    process.env.YANDEX_GEO_API_KEY = KEY;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`connect ECONNREFUSED https://search-maps.yandex.ru/v1/?apikey=${KEY}`);
      }),
    );

    await expect(
      yandexGeoConnector.search({ rubric: "автосервис", city: "Екатеринбург" }),
    ).rejects.toThrow(/<ключ>/);

    await expect(
      yandexGeoConnector.search({ rubric: "автосервис", city: "Екатеринбург" }),
    ).rejects.not.toThrow(new RegExp(KEY));
  });

  it("ошибка HTTP несёт только статус, без тела ответа", async () => {
    // Тело ответа Яндекса может содержать эхо запроса вместе с ключом.
    process.env.YANDEX_GEO_API_KEY = KEY;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(`{"error":"apikey=${KEY}"}`, { status: 500 })),
    );

    let message = "";
    try {
      await yandexGeoConnector.search({ rubric: "автосервис", city: "Екатеринбург" });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("500");
    expect(message).not.toContain(KEY);
  });
});

describe("ненастроенный источник", () => {
  it("без ключа отказывает внятно и не ходит в сеть", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      yandexGeoConnector.search({ rubric: "автосервис", city: "Екатеринбург" }),
    ).rejects.toThrow(ConnectorError);
    expect(fetchSpy).not.toHaveBeenCalled();
    // И квоту тоже не тратит: запроса не было.
    expect(reserve).not.toHaveBeenCalled();
  });

  it("не попадает в список настроенных", () => {
    expect(configuredConnectors().map((c) => c.id)).not.toContain("yandex_geo");
    expect(defaultConnector()).toBeNull();
  });
});

describe("разбор выдачи", () => {
  it("организация превращается в кандидата со всеми полями", () => {
    const company = toCompany(feature(), "Екатеринбург");
    expect(company).not.toBeNull();
    expect(company).toMatchObject({
      externalId: "1234567890",
      source: "yandex_geo",
      name: "Автосервис на Ленина",
      niche: "AUTO_SERVICE",
      city: "Екатеринбург",
      phones: ["+7 (999) 123-45-67"],
      site: "https://example.ru",
      rating: 4.6,
      reviewsCount: 128,
    });
  });

  it("организация из справочника не помечается персданными", () => {
    // Пометка нужна для частных мастеров с Avito. Ставить её всем подряд
    // значит обесценить её там, где она действительно защищает.
    expect(toCompany(feature(), "Екатеринбург")?.isPersonalData).toBe(false);
  });

  it("запись без id или названия отбрасывается", () => {
    // Её нечем дедуплицировать и незачем показывать: «Без названия» в списке
    // кандидатов — мусор, который придётся разбирать руками.
    expect(toCompany(feature({ id: undefined }), "Екатеринбург")).toBeNull();
    expect(toCompany(feature({ name: undefined }), "Екатеринбург")).toBeNull();
  });

  it("непонятная категория — OTHER, а не догадка", () => {
    const other = toCompany(
      feature({ name: "Пекарня «Тёплый хлеб»", Categories: [{ name: "Пекарня" }] }),
      "Екатеринбург",
    );
    expect(other?.niche).toBe("OTHER");
  });

  it("отсутствующие рейтинг и телефоны не ломают разбор", () => {
    const bare = toCompany(feature({ Phones: undefined, Rating: undefined }), "Екатеринбург");
    expect(bare?.phones).toEqual([]);
    expect(bare?.rating).toBeNull();
    expect(bare?.reviewsCount).toBeNull();
  });
});

describe("пагинация", () => {
  it("курсор двигается и заканчивается на неполной странице", async () => {
    process.env.YANDEX_GEO_API_KEY = KEY;
    const page = (n: number) =>
      new Response(JSON.stringify({ features: Array.from({ length: n }, () => feature()) }), {
        status: 200,
      });

    vi.stubGlobal("fetch", vi.fn(async () => page(50)));
    const full = await yandexGeoConnector.search({
      rubric: "автосервис",
      city: "Екатеринбург",
      pageSize: 50,
    });
    // Полная страница — источник наверняка отдал не всё.
    expect(full.nextCursor).toEqual({ skip: 50 });

    vi.stubGlobal("fetch", vi.fn(async () => page(7)));
    const tail = await yandexGeoConnector.search({
      rubric: "автосервис",
      city: "Екатеринбург",
      pageSize: 50,
      cursor: { skip: 50 },
    });
    expect(tail.nextCursor).toBeNull();
  });

  it("курсор уходит в запрос параметром skip", async () => {
    process.env.YANDEX_GEO_API_KEY = KEY;
    const fetchSpy = vi.fn(
      async (..._a: unknown[]) => new Response(JSON.stringify({ features: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await yandexGeoConnector.search({
      rubric: "автосервис",
      city: "Екатеринбург",
      cursor: { skip: 100 },
    });

    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(url.searchParams.get("skip")).toBe("100");
    expect(url.searchParams.get("type")).toBe("biz");
  });
});

describe("заглушка", () => {
  it("по умолчанию выключена", () => {
    // Молча подсунуть выдуманные компании в воронку владельца — худшее, что
    // она может сделать.
    expect(stubConnector.isConfigured()).toBe(false);
    expect(configuredConnectors().map((c) => c.id)).not.toContain("stub");
  });

  it("включается флагом и отдаёт помеченные демо-данные", async () => {
    process.env.SALES_STUB_CONNECTOR = "1";
    expect(stubConnector.isConfigured()).toBe(true);

    const res = await stubConnector.search({ rubric: "автосервис", city: "Екатеринбург" });
    expect(res.companies.length).toBeGreaterThan(0);
    // Даже попав в CRM, они не притворяются настоящими.
    for (const c of res.companies) expect(c.name).toMatch(/^\[demo\]/);
  });

  it("идёт через тот же троттлинг, что и настоящий источник", async () => {
    // Если заглушка обходит троттлинг, она проверяет не ту систему, которая
    // поедет в прод.
    process.env.SALES_STUB_CONNECTOR = "1";
    await stubConnector.search({ rubric: "автосервис", city: "Екатеринбург" });
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it("телефоны различаются — дедуп по номеру проверяем на них", async () => {
    process.env.SALES_STUB_CONNECTOR = "1";
    const res = await stubConnector.search({ rubric: "автосервис", city: "Екатеринбург", pageSize: 8 });
    const phones = res.companies.map((c) => c.phones[0]);
    expect(new Set(phones).size).toBe(phones.length);
  });

  it("курсор доходит до конца и останавливается", async () => {
    process.env.SALES_STUB_CONNECTOR = "1";
    let cursor: Record<string, unknown> | null | undefined = null;
    let pages = 0;
    let total = 0;

    do {
      const res = await stubConnector.search({
        rubric: "автосервис",
        city: "Екатеринбург",
        pageSize: 3,
        cursor,
      });
      cursor = res.nextCursor;
      total += res.companies.length;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor);

    expect(total).toBeGreaterThan(0);
  });
});

describe("реестр", () => {
  it("находит источник по идентификатору", () => {
    expect(connectorById("yandex_geo")?.label).toBe("Яндекс Geosearch");
    expect(connectorById("two_gis")).toBeNull();
  });

  it("настоящий источник приоритетнее заглушки", () => {
    process.env.YANDEX_GEO_API_KEY = KEY;
    process.env.SALES_STUB_CONNECTOR = "1";
    expect(defaultConnector()?.id).toBe("yandex_geo");
  });
});
