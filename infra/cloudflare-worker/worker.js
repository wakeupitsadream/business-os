/**
 * Cloudflare Worker — двусторонний прокси Telegram для Business OS.
 *
 * Зачем он вообще нужен. Timeweb блокирует прямой доступ к api.telegram.org,
 * поэтому исходящие вызовы Bot API из контейнера не проходят. Обратное
 * направление не лучше: прямая доставка вебхуков Telegram → российский хостинг
 * фильтруется на входе и ретраится минутами — владелец пишет боту и получает
 * ответ через десять минут, хотя генерация заняла три секунды.
 *
 * Worker решает оба направления одним хостом (например tg.example.com):
 *
 *   ИСХОДЯЩЕЕ   приложение → https://tg.example.com/bot<TOKEN>/sendMessage
 *                          → api.telegram.org         (env TELEGRAM_API_BASE)
 *   ВХОДЯЩЕЕ    Telegram   → https://tg.example.com/api/telegram/webhook
 *                          → https://os.example.com/… (env TELEGRAM_WEBHOOK_BASE)
 *
 * Развёртывание — см. README.md рядом.
 *
 * Переменные Worker (Settings → Variables):
 *   ORIGIN — базовый URL приложения, например https://os.example.com
 */

/** Пути, которые форвардятся в приложение, а не в Telegram. */
const APP_PATHS = new Set(["/api/telegram/webhook"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (APP_PATHS.has(url.pathname)) {
      return forwardToApp(request, url, env);
    }

    // Методы Bot API: /bot<токен>/<метод>.
    if (url.pathname.startsWith("/bot")) {
      return forwardToTelegram(request, url);
    }

    // Скачивание файлов: /file/bot<токен>/<путь>. Это ОТДЕЛЬНЫЙ путь Telegram,
    // а не метод API, и раньше он сюда не попадал — приложение получало 404 и
    // не могло прочитать ни присланную выписку, ни фото. Ответ стримится как
    // есть, без буферизации: файл может быть в десятки мегабайт, а память
    // Worker считается за весь запрос.
    if (url.pathname.startsWith("/file/bot")) {
      return forwardToTelegram(request, url);
    }

    // Всё остальное — не наше. Отвечаем нейтрально, без подсказок о том, что
    // за этим хостом стоит: Worker публичен, его адрес рано или поздно попадёт
    // в чужие логи и сканеры.
    return new Response("Not found", { status: 404 });
  },
};

/**
 * Вебхук от Telegram → приложение.
 *
 * Заголовок X-Telegram-Bot-Api-Secret-Token пробрасывается как есть: именно по
 * нему приложение отличает настоящий апдейт от постороннего запроса. Тело
 * читаем целиком — стримить нечего, апдейты маленькие, а буферизация даёт
 * возможность повторить запрос при разовом сбое.
 */
async function forwardToApp(request, url, env) {
  const origin = (env.ORIGIN || "").replace(/\/+$/, "");
  if (!origin) {
    // Пустой ORIGIN — ошибка конфигурации Worker. Отвечаем 200, иначе Telegram
    // будет ретраить апдейт бесконечно, пока конфигурацию не починят.
    console.error("ORIGIN не задан в переменных Worker");
    return new Response("ok", { status: 200 });
  }

  const target = `${origin}${url.pathname}${url.search}`;
  const body = await request.arrayBuffer();

  const headers = new Headers();
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secret) headers.set("X-Telegram-Bot-Api-Secret-Token", secret);
  headers.set("Content-Type", request.headers.get("Content-Type") || "application/json");

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(target, { method: request.method, headers, body });
      // Ответ приложения возвращаем Telegram как есть: 401 при неверном секрете
      // должен дойти до отправителя, а не быть замаскирован двухсоткой.
      return new Response(await res.arrayBuffer(), {
        status: res.status,
        headers: { "Content-Type": res.headers.get("Content-Type") || "application/json" },
      });
    } catch (e) {
      console.error(`форвард в приложение не удался (попытка ${attempt}):`, e);
      if (attempt === 1) await new Promise((r) => setTimeout(r, 300));
    }
  }

  // Приложение недоступно (передеплой). 200 — сознательно: ретраи Telegram
  // растягиваются на минуты и вызывают лавину дублей, когда прод вернётся.
  // Потерять один апдейт во время деплоя дешевле.
  return new Response("ok", { status: 200 });
}

/** Вызов Bot API из приложения → api.telegram.org. */
async function forwardToTelegram(request, url) {
  const target = `https://api.telegram.org${url.pathname}${url.search}`;

  const headers = new Headers(request.headers);
  // Host подставит fetch сам; чужой Host ломает TLS-роутинг на стороне Telegram.
  headers.delete("host");

  const init = {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
  };

  try {
    const res = await fetch(target, init);
    return new Response(res.body, { status: res.status, headers: res.headers });
  } catch (e) {
    console.error("вызов Telegram не удался:", e);
    // Форма ответа — как у Bot API, чтобы клиент разобрал ошибку своим
    // обычным путём, а не упал на неожиданном формате.
    return new Response(
      JSON.stringify({ ok: false, error_code: 502, description: "proxy: telegram unreachable" }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}
