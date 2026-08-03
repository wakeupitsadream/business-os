import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSucceededPayments, YooKassaError, yooConfigured } from "./client";

/**
 * Клиент ЮKassa на подменённом fetch.
 *
 * Главное здесь — не «работает ли запрос», а как клиент ведёт себя, когда
 * чужой сервис отвечает не так, как обещал. Молчаливый пустой список вместо
 * ошибки — худший исход: он выглядит как «платежей не было».
 */

const SINCE = new Date("2026-07-28T00:00:00Z");

function page(items: unknown[], nextCursor?: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ type: "list", items, ...(nextCursor ? { next_cursor: nextCursor } : {}) }),
  } as unknown as Response;
}

function payment(id: string) {
  return {
    id,
    status: "succeeded",
    amount: { value: "1000.00", currency: "RUB" },
    created_at: "2026-07-29T10:00:00.000Z",
  };
}

beforeEach(() => {
  process.env.YOOKASSA_SHOP_ID = "123456";
  process.env.YOOKASSA_SECRET_KEY = "test_secret";
});

afterEach(() => {
  delete process.env.YOOKASSA_SHOP_ID;
  delete process.env.YOOKASSA_SECRET_KEY;
});

describe("настроенность", () => {
  it("нужны обе переменные", () => {
    expect(yooConfigured()).toBe(true);
    delete process.env.YOOKASSA_SECRET_KEY;
    expect(yooConfigured()).toBe(false);
  });

  it("без ключей запрос не уходит вовсе", async () => {
    delete process.env.YOOKASSA_SHOP_ID;
    const fetchImpl = vi.fn();
    await expect(fetchSucceededPayments({ since: SINCE, fetchImpl })).rejects.toThrow(YooKassaError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("запрос", () => {
  it("просит только успешные платежи и передаёт нижнюю границу", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => page([]));
    await fetchSucceededPayments({ since: SINCE, fetchImpl });

    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.searchParams.get("status")).toBe("succeeded");
    // Граница по ПОДТВЕРЖДЕНИЮ: платёж с холдом создаётся в один день, а
    // становится успешным через несколько, и фильтр по дате создания его
    // к этому моменту уже не захватывает.
    expect(url.searchParams.get("captured_at.gte")).toBe(SINCE.toISOString());
  });

  it("по дате создания НЕ фильтрует", async () => {
    // ЮKassa соединяет фильтры по AND: оставленный рядом created_at.gte
    // сохранил бы потерю в неприкосновенности, притом что captured_at.gte
    // в запросе есть и код выглядит починенным.
    const fetchImpl = vi.fn<typeof fetch>(async () => page([]));
    await fetchSucceededPayments({ since: SINCE, fetchImpl });

    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.searchParams.get("created_at.gte")).toBeNull();
    expect(url.searchParams.get("created_at.gt")).toBeNull();
  });

  it("авторизуется Basic-заголовком, ключ в URL не уходит", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => page([]));
    await fetchSucceededPayments({ since: SINCE, fetchImpl });

    const init = fetchImpl.mock.calls[0]?.[1];
    const auth = (init?.headers as Record<string, string>).Authorization;
    expect(auth).toBe(`Basic ${Buffer.from("123456:test_secret").toString("base64")}`);
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain("test_secret");
  });
});

describe("пагинация", () => {
  it("обходит все страницы по курсору", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(page([payment("a"), payment("b")], "cursor-2"))
      .mockResolvedValueOnce(page([payment("c")]));

    const payments = await fetchSucceededPayments({ since: SINCE, fetchImpl });

    expect(payments.map((p) => p.id)).toEqual(["a", "b", "c"]);
    const secondUrl = new URL(String(fetchImpl.mock.calls[1]?.[0]));
    expect(secondUrl.searchParams.get("cursor")).toBe("cursor-2");
  });

  it("останавливается, когда курсор кончился", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => page([payment("a")]));
    await fetchSucceededPayments({ since: SINCE, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("зациклившийся курсор не крутится вечно и не возвращает часть данных", async () => {
    // Вернуть половину выручки молча хуже, чем упасть: неполные цифры на
    // экране выглядят как настоящие.
    const fetchImpl = vi.fn<typeof fetch>(async () => page([payment("a")], "same-cursor"));
    await expect(fetchSucceededPayments({ since: SINCE, fetchImpl })).rejects.toThrow(
      /Пагинация/,
    );
  });
});

describe("ошибки чужого сервиса", () => {
  it("неверный ключ распознаётся отдельно", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ({ ok: false, status: 401 }) as Response);
    await expect(fetchSucceededPayments({ since: SINCE, fetchImpl })).rejects.toMatchObject({
      kind: "auth",
    });
  });

  it("пятисотка не превращается в пустой список платежей", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ({ ok: false, status: 500 }) as Response);
    await expect(fetchSucceededPayments({ since: SINCE, fetchImpl })).rejects.toMatchObject({
      kind: "http",
    });
  });

  it("неожиданный формат ответа — ошибка, а не тишина", async () => {
    // Смена формата у чужого API иначе выглядела бы как «платежей ноль» и
    // обнаружилась бы через месяц по недостающей выручке.
    const fetchImpl = vi.fn<typeof fetch>(
      async () => ({ ok: true, status: 200, json: async () => ({ foo: "bar" }) }) as Response,
    );
    await expect(fetchSucceededPayments({ since: SINCE, fetchImpl })).rejects.toMatchObject({
      kind: "shape",
    });
  });

  it("платёж без обязательных полей роняет разбор, а не проезжает наполовину", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => page([{ id: "a", status: "succeeded" }]));
    await expect(fetchSucceededPayments({ since: SINCE, fetchImpl })).rejects.toMatchObject({
      kind: "shape",
    });
  });

  it("сетевой сбой не выдаёт себя за пустую выборку", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(fetchSucceededPayments({ since: SINCE, fetchImpl })).rejects.toMatchObject({
      kind: "network",
    });
  });
});
