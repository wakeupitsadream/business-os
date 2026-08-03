"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Горячие клавиши.
 *
 * Пульт открывают по многу раз в день, и каждый раз путь один и тот же: мышь,
 * боковое меню, нужный раздел. С клавиатуры это одно движение.
 *
 * Набор намеренно крошечный: переходы между отделами и подсказка. Хоткей на
 * действие (создать, удалить, отправить) здесь не нужен — действия у владельца
 * редкие и осознанные, а случайное нажатие в необратимом действии дороже
 * сэкономленной секунды.
 */

const ROUTES: Array<{ key: string; path: string; label: string }> = [
  { key: "1", path: "/", label: "Обзор" },
  { key: "2", path: "/secretary", label: "Секретарь" },
  { key: "3", path: "/finance", label: "Финансы" },
  { key: "4", path: "/sales", label: "Продажи" },
  { key: "5", path: "/settings", label: "Настройки" },
];

/** Печатает ли владелец прямо сейчас: тогда цифры принадлежат тексту. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable ||
    // Диалог перехватывает клавиатуру целиком: цифра там может быть суммой.
    target.closest("[role=dialog]") !== null
  );
}

export function Hotkeys() {
  const router = useRouter();
  const [help, setHelp] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Модификаторы отдаём браузеру и системе: Cmd+1 переключает вкладку, и
      // перехватывать это — воровать привычное поведение.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) return;

      if (e.key === "?") {
        e.preventDefault();
        setHelp((v) => !v);
        return;
      }
      if (e.key === "Escape") {
        setHelp(false);
        return;
      }

      const route = ROUTES.find((r) => r.key === e.key);
      if (route) {
        e.preventDefault();
        router.push(route.path);
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  if (!help) return null;

  return (
    <div
      role="dialog"
      aria-label="Горячие клавиши"
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 p-6"
      onClick={() => setHelp(false)}
    >
      <div
        className="w-full max-w-xs rounded-md border border-line bg-surface p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="label-xs text-muted">Горячие клавиши</p>
        <ul className="mt-3 space-y-2">
          {ROUTES.map((r) => (
            <li key={r.key} className="flex items-center justify-between gap-3">
              <span className="text-sm text-fg">{r.label}</span>
              <kbd className="num rounded border border-line bg-surface-2 px-1.5 py-0.5 text-xs text-muted">
                {r.key}
              </kbd>
            </li>
          ))}
          <li className="flex items-center justify-between gap-3 border-t border-line pt-2">
            <span className="text-sm text-muted">Эта подсказка</span>
            <kbd className="num rounded border border-line bg-surface-2 px-1.5 py-0.5 text-xs text-muted">
              ?
            </kbd>
          </li>
        </ul>
      </div>
    </div>
  );
}
