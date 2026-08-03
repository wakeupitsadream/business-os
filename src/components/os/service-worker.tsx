"use client";

import { useEffect } from "react";

/**
 * Регистрация service worker'а.
 *
 * Отдельный клиентский компонент, а не скрипт в разметке: так регистрация
 * живёт в одном месте и её видно при чтении дерева, а не только в HTML.
 *
 * Версия сборки уходит в адрес параметром. Браузер считает воркер изменившимся
 * побайтовым сравнением файла, а `sw.js` от сборки к сборке не меняется —
 * без параметра он остался бы старым навсегда и продолжал отдавать ассеты
 * предыдущего деплоя.
 */
export function ServiceWorkerRegistration({ version }: { version: string }) {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // В разработке воркер только мешает: ассеты меняются каждую секунду, а он
    // отдаёт их из кэша, и правка «не применяется» без всякой причины.
    if (process.env.NODE_ENV !== "production") return;

    const controller = new AbortController();
    navigator.serviceWorker.register(`/sw.js?v=${version}`).catch(() => {
      // Молча: неработающий кэш — не повод показывать владельцу ошибку,
      // приложение без воркера работает ровно так же, просто медленнее.
    });
    return () => controller.abort();
  }, [version]);

  return null;
}
