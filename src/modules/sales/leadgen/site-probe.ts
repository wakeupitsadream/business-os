/**
 * Заглянуть на главную страницу сайта кандидата.
 *
 * Зачем: по справочнику видно «сайт есть», но не видно, что на нём. Продукт
 * продаётся тем, у кого поток клиентов есть, а онлайн-записи нет, — и узнать
 * это можно только заглянув.
 *
 * **Адрес приходит из чужого справочника, то есть ему нельзя доверять.**
 * Запрос с нашего сервера по произвольному URL — это SSRF: строка
 * `http://169.254.169.254/` в поле сайта заставит приложение сходить за
 * метаданными хостинга и отдать их модели. Поэтому здесь три ограничения, и
 * каждое из них обязательно:
 *
 * 1. только http/https — никаких `file:`, `gopher:`, `data:`;
 * 2. частные, петлевые и link-local адреса запрещены — и на каждом переходе,
 *    а не только на первом: редирект на 127.0.0.1 обходит проверку входа;
 * 3. читаем не больше двух килобайт и не дольше восьми секунд — страница на
 *    сто мегабайт не должна занимать тик крона.
 */

/** Сколько текста берём. Больше и не нужно: решение принимается по первому экрану. */
const MAX_BYTES = 2048;
const TIMEOUT_MS = 8_000;
/** Сколько переходов проходим. Два покрывают http→https и apex→www. */
const MAX_REDIRECTS = 2;

export type SiteProbe =
  | { ok: true; text: string }
  | { ok: false; reason: "no-site" | "blocked" | "unreachable" | "empty" };

/**
 * Адрес, по которому серверу ходить нельзя.
 *
 * Проверяются литералы, а не результат разрешения имени: полноценная защита
 * требовала бы резолвить имя и сверять КАЖДЫЙ адрес, да ещё и переживать
 * повторный резолв перед соединением. Здесь закрыт реалистичный случай —
 * адрес метаданных и внутренние имена, попавшие в справочник, — и это
 * честная граница, а не иллюзия полной защиты.
 */
export function isForbiddenHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  // Имя без точки — это внутренний хост сети, а не сайт автосервиса.
  if (!host.includes(".") && !host.includes(":")) return true;

  // IPv6: петля и unique-local.
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd")) return true;
  if (host.startsWith("fe80:")) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;

  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, там же метаданные
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

export function normalizeSiteUrl(raw: string | null | undefined): URL | null {
  const value = raw?.trim();
  if (!value) return null;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (isForbiddenHost(url.hostname)) return null;
  return url;
}

export async function probeSite(rawUrl: string | null | undefined): Promise<SiteProbe> {
  let url = normalizeSiteUrl(rawUrl);
  if (!url) return { ok: false, reason: rawUrl?.trim() ? "blocked" : "no-site" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      // Редиректы разбираем сами: `redirect: "follow"` увёл бы нас на
      // 127.0.0.1 в обход проверки, сделанной только для первого адреса.
      const res = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "text/html,text/plain;q=0.9" },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return { ok: false, reason: "unreachable" };
        const next = normalizeSiteUrl(new URL(location, url).toString());
        if (!next) return { ok: false, reason: "blocked" };
        url = next;
        continue;
      }

      if (!res.ok) return { ok: false, reason: "unreachable" };

      const text = toPlainText(await readCapped(res));
      return text.length > 0 ? { ok: true, text } : { ok: false, reason: "empty" };
    }

    return { ok: false, reason: "unreachable" };
  } catch {
    // Недоступный сайт — обычное дело и не повод для тревоги: у половины
    // автосервисов он лежит. Это тоже сигнал, и он поедет в скоринг.
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/** Прочитать не больше `MAX_BYTES`, не дожидаясь конца ответа. */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, MAX_BYTES * 2);

  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      size += value.length;
    }
  }
  // Соединение закрывается сразу: качать остаток страницы незачем.
  await reader.cancel().catch(() => undefined);

  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk.subarray(0, Math.min(chunk.length, size - offset)), offset);
    offset += chunk.length;
    if (offset >= size) break;
  }

  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

/** HTML → текст. Грубо и намеренно: модели нужен смысл, а не разметка. */
export function toPlainText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_BYTES);
}
