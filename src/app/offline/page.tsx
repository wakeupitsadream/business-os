import type { Metadata } from "next";
import { CloudOff } from "lucide-react";

/**
 * Страница «нет связи».
 *
 * Существует затем, чтобы оффлайн НЕ показывал старые цифры. Кэшированный
 * остаток счёта выглядит точно так же, как настоящий, и владелец примет по
 * нему решение — а он может быть вчерашним. Пустая честная страница здесь
 * полезнее правдоподобной.
 *
 * Отдаётся service worker'ом из кэша, поэтому не должна зависеть ни от базы,
 * ни от сессии.
 */

export const metadata: Metadata = { title: "Нет связи — Business OS" };

export default function OfflinePage() {
  return (
    <div className="flex min-h-dvh items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <CloudOff aria-hidden className="mx-auto size-10 text-muted" />
        <h1 className="mt-4 text-lg font-medium text-fg">Нет связи с сервером</h1>
        <p className="mt-2 text-sm text-muted">
          Цифры специально не показываются из кэша: вчерашний остаток выглядит как сегодняшний,
          и по нему легко принять неверное решение.
        </p>
        <p className="mt-4 text-sm text-muted">Появится сеть — просто обновите страницу.</p>
      </div>
    </div>
  );
}
