import { optionalEnv } from "@/core/env";
import { logWarn } from "@/core/observability/logger";
import { YooPaymentList, type YooPayment } from "./types";

/**
 * HTTP-клиент ЮKassa. Отделён от логики синка намеренно: `sync.ts` не должен
 * знать про заголовки и пагинацию, а тесты синка — про моки fetch.
 *
 * Ключ нужен ТОЛЬКО на чтение платежей. Ключ с правами на возвраты и выплаты
 * в системе учёта не нужен вовсе, а стоит на порядок дороже при утечке.
 */

const BASE_URL = "https://api.yookassa.ru/v3";
const TIMEOUT_MS = 20_000;
/** Потолок страниц на прогон: защита от бесконечного курсора при их ошибке. */
const MAX_PAGES = 50;
const PAGE_SIZE = 100;

export class YooKassaError extends Error {
  constructor(
    message: string,
    readonly kind: "config" | "auth" | "http" | "shape" | "network",
  ) {
    super(message);
    this.name = "YooKassaError";
  }
}

export function yooConfigured(): boolean {
  return Boolean(optionalEnv("YOOKASSA_SHOP_ID") && optionalEnv("YOOKASSA_SECRET_KEY"));
}

function authHeader(): string {
  const shopId = optionalEnv("YOOKASSA_SHOP_ID");
  const secret = optionalEnv("YOOKASSA_SECRET_KEY");
  if (!shopId || !secret) {
    throw new YooKassaError("Не заданы YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY", "config");
  }
  return `Basic ${Buffer.from(`${shopId}:${secret}`).toString("base64")}`;
}

export interface FetchPaymentsOptions {
  /**
   * Нижняя граница по дате ПОДТВЕРЖДЕНИЯ, не создания.
   *
   * Двухстадийный платёж (холд, доплата, ручное подтверждение) создаётся в
   * один день, а подтверждается через несколько — у ЮKassa окно подтверждения
   * измеряется днями. Успешным он становится в момент подтверждения, и только
   * тогда впервые попадает под `status=succeeded`. Фильтр по дате СОЗДАНИЯ его
   * к этому времени уже не захватывает, а окно синка монотонно едет вперёд —
   * значит платёж не попадёт ни в одно последующее окно. Никогда.
   */
  since: Date;
  /** Подменяется в тестах; в проде — глобальный fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Все успешные платежи с указанной даты, со всех страниц.
 *
 * Курсорная пагинация, а не offset: у ЮKassa именно она, и на смещениях
 * страницы разъезжаются при появлении новых платежей во время обхода.
 */
export async function fetchSucceededPayments(opts: FetchPaymentsOptions): Promise<YooPayment[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const auth = authHeader();

  const payments: YooPayment[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(`${BASE_URL}/payments`);
    url.searchParams.set("status", "succeeded");
    url.searchParams.set("limit", String(PAGE_SIZE));
    // Именно captured_at, и created_at.gte здесь быть не должно: ЮKassa
    // соединяет фильтры по AND, и оставленный рядом created_at.gte сохранил бы
    // потерю в неприкосновенности, притом что код выглядел бы починенным.
    // У succeeded-платежа captured_at есть всегда, так что выборка не сужается.
    url.searchParams.set("captured_at.gte", opts.since.toISOString());
    if (cursor) url.searchParams.set("cursor", cursor);

    const body = await requestJson(doFetch, url, auth);
    const parsed = YooPaymentList.safeParse(body);
    if (!parsed.success) {
      throw new YooKassaError(
        `Ответ ЮKassa не соответствует ожидаемому формату: ${parsed.error.issues[0]?.message ?? "неизвестно"}`,
        "shape",
      );
    }

    payments.push(...parsed.data.items);
    cursor = parsed.data.next_cursor;
    if (!cursor) return payments;
  }

  // Курсор не кончился за 50 страниц (5 000 платежей за окно в двое суток).
  // Это не наш объём — скорее всего курсор зациклился, и молча вернуть часть
  // данных значит записать неполную выручку.
  logWarn("yookassa.pagination_limit", { pages: MAX_PAGES, collected: payments.length });
  throw new YooKassaError("Пагинация ЮKassa не завершилась за разумное число страниц", "http");
}

async function requestJson(
  doFetch: typeof fetch,
  url: URL,
  auth: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await doFetch(url.toString(), {
      method: "GET",
      headers: { Authorization: auth, Accept: "application/json" },
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      throw new YooKassaError("ЮKassa отклонила ключ: проверьте shopId и секретный ключ", "auth");
    }
    if (!response.ok) {
      throw new YooKassaError(`ЮKassa ответила ${response.status}`, "http");
    }

    return await response.json();
  } catch (e) {
    if (e instanceof YooKassaError) throw e;
    const message = e instanceof Error ? e.message : String(e);
    throw new YooKassaError(`Не удалось получить платежи: ${message}`, "network");
  } finally {
    clearTimeout(timer);
  }
}
