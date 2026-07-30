"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";
import { formatKop } from "@/core/shared/money";

/**
 * Режим приватности: суммы на экране заменяются точками.
 *
 * Нужен ровно для одного сценария — показать экран кому-то (созвон с
 * демонстрацией, ноутбук в кофейне), не показав обороты. Это не защита
 * данных: числа по-прежнему приходят на клиент, и в исходнике страницы они
 * есть. Защита — это вход по паролю, она уже стоит перед этой страницей.
 *
 * Состояние хранится в localStorage: если владелец включил режим перед
 * созвоном, обновление страницы посреди созвона не должно всё раскрыть.
 */

const STORAGE_KEY = "bos.finance.privacy";

const PrivacyContext = createContext<{ hidden: boolean; toggle: () => void }>({
  hidden: false,
  toggle: () => {},
});

export function PrivacyProvider({ children }: { children: ReactNode }) {
  // Стартуем всегда с «показывать»: чтение localStorage при первом рендере
  // рассинхронизировало бы разметку сервера и клиента (гидратация ругается),
  // а моргание в обратную сторону — «сумма мелькнула и скрылась» — здесь
  // безопаснее, чем «скрыто, но на секунду показалось».
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    setHidden(window.localStorage.getItem(STORAGE_KEY) === "1");
  }, []);

  const toggle = () => {
    setHidden((prev) => {
      const next = !prev;
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  };

  return <PrivacyContext.Provider value={{ hidden, toggle }}>{children}</PrivacyContext.Provider>;
}

export function usePrivacy() {
  return useContext(PrivacyContext);
}

/** Денежная сумма с учётом режима приватности. Форматирование — одно на всё. */
export function Money({
  kop,
  sign = false,
  className,
}: {
  kop: number;
  sign?: boolean;
  className?: string;
}) {
  const { hidden } = usePrivacy();
  return (
    <span className={className}>{hidden ? "••• ₽" : formatKop(kop, { sign })}</span>
  );
}

export function PrivacyToggle() {
  const { hidden, toggle } = usePrivacy();
  const Icon = hidden ? EyeOff : Eye;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={hidden}
      className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-xs text-muted transition-colors hover:text-fg"
    >
      <Icon aria-hidden className="size-3.5" />
      {hidden ? "Показать суммы" : "Скрыть суммы"}
    </button>
  );
}
