/*
 * Service worker.
 *
 * ГЛАВНОЕ РЕШЕНИЕ: динамика НЕ кэшируется. Никогда.
 *
 * Соблазн очевиден — закэшировать страницы, чтобы приложение открывалось
 * мгновенно и работало в метро. Но весь этот продукт держится на том, что
 * цифра на экране верна: остаток счёта, выручка месяца, число активных сделок.
 * Показать вчерашнюю выручку так же, как сегодняшнюю, — это не «оффлайн-режим»,
 * а тихая ложь, по которой владелец примет решение. Хуже неё только показать
 * вчерашний остаток перед оплатой.
 *
 * Поэтому кэшируется ровно то, что не может устареть по смыслу: сборочные
 * ассеты (у них хэш в имени), иконки и манифест. Всё остальное идёт в сеть, а
 * когда сети нет — честная страница «нет связи» вместо старых чисел.
 *
 * Fetch-обработчик здесь обязателен ещё и формально: без него браузер не
 * считает приложение устанавливаемым.
 */

// Имя версии меняется при каждом деплое через ?v= в регистрации: старый кэш
// иначе живёт вечно и отдаёт ассеты от предыдущей сборки.
const CACHE = "bos-shell-v1";

/** Что кладём в кэш заранее: оболочка, без которой нечего показать оффлайн. */
const PRECACHE = ["/offline", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // addAll падает целиком, если хоть один адрес не ответил, и тогда
      // воркер не установится вовсе. Кладём по одному и переживаем промахи.
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Можно ли это кэшировать: только неизменяемое и только своё. */
function isCacheable(url) {
  if (url.origin !== self.location.origin) return false;
  // API — это данные. Ответ вчерашнего запроса сегодня неверен.
  if (url.pathname.startsWith("/api/")) return false;
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith(".svg") ||
    url.pathname.endsWith(".woff2") ||
    url.pathname === "/manifest.webmanifest"
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (isCacheable(url)) {
    // Ассеты сборки неизменяемы: в имени хэш, и содержимое по этому адресу уже
    // не поменяется. Кэш-первым — безопасно и быстро.
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Навигация: всегда в сеть. Нет сети — честная страница, а не старые цифры.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches
          .match("/offline")
          .then(
            (hit) =>
              hit ??
              new Response("Нет связи с сервером.", {
                status: 503,
                headers: { "content-type": "text/plain; charset=utf-8" },
              }),
          ),
      ),
    );
    return;
  }

  // Всё остальное — включая /api — воркер не трогает вовсе.
});
