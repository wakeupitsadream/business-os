"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Banknote,
  Code,
  Headset,
  LayoutDashboard,
  LogOut,
  Settings,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/core/shared/cn";
import { OWNER_TZ } from "@/core/shared/time";
import { AgentStatus } from "@/components/os/agent-status";

export interface NavItem {
  href: string;
  label: string;
  /** Короткая подпись для нижней навигации на телефоне. */
  short: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "HQ", short: "HQ", icon: LayoutDashboard },
  { href: "/secretary", label: "Секретарь", short: "Секретарь", icon: Headset },
  { href: "/finance", label: "Финансы", short: "Финансы", icon: Banknote },
  { href: "/sales", label: "Продажи", short: "Продажи", icon: TrendingUp },
  { href: "/dev", label: "Разработка", short: "Разраб.", icon: Code },
  { href: "/settings", label: "Настройки", short: "Ещё", icon: Settings },
];

/**
 * HQ живёт на «/», поэтому startsWith подсветил бы его на любой странице —
 * корень сравниваем строго.
 */
export function isActivePath(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function currentSectionLabel(pathname: string): string {
  const match = NAV_ITEMS.find((item) => isActivePath(pathname, item.href));
  return match?.label ?? "Business OS";
}

/** Боковая навигация. На телефоне скрыта — там работает нижняя панель. */
export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[220px] flex-col border-r border-line bg-surface md:flex">
      <div className="flex h-14 items-center gap-2 border-b border-line px-4">
        <span className="size-2 rounded-full bg-accent" aria-hidden />
        <span className="label-xs text-fg">Business OS</span>
      </div>

      <nav className="flex-1 overflow-y-auto p-2" aria-label="Отделы">
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => {
            const active = isActivePath(pathname, item.href);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                    active
                      ? "bg-surface-2 text-accent"
                      : "text-muted hover:bg-surface-2 hover:text-fg",
                  )}
                >
                  <Icon aria-hidden className="size-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                  {active ? (
                    <span aria-hidden className="ml-auto h-4 w-0.5 rounded-full bg-accent" />
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-line p-3">
        <LogoutButton compact />
      </div>
    </aside>
  );
}

/**
 * Нижняя навигация телефона — основной способ доступа с мобильного.
 * Фиксирована, с отступом под «домашнюю полосу» iOS (safe-area).
 */
export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Отделы"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="grid grid-cols-6">
        {NAV_ITEMS.map((item) => {
          const active = isActivePath(pathname, item.href);
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-14 flex-col items-center justify-center gap-1 transition-colors",
                  active ? "text-accent" : "text-muted",
                )}
              >
                <Icon aria-hidden className="size-5" />
                <span className="text-[10px] leading-none">{item.short}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Верхняя полоса: где мы, чем занят агент, сколько времени у владельца. */
export function Topbar() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-bg/95 px-4 backdrop-blur md:px-6">
      <h1 className="truncate text-sm font-medium text-fg">{currentSectionLabel(pathname)}</h1>
      <AgentStatus state="idle" name="Ася" className="hidden sm:inline-flex" />
      <div className="ml-auto flex items-center gap-3">
        <OwnerClock />
      </div>
    </header>
  );
}

const CLOCK_FORMAT = new Intl.DateTimeFormat("ru-RU", {
  timeZone: OWNER_TZ,
  weekday: "short",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * Часы владельца (МСК). Значение появляется только после монтирования:
 * серверный и клиентский рендер разошлись бы по минутам и React ругался бы
 * на несовпадение разметки при каждой загрузке.
 */
export function OwnerClock() {
  const [now, setNow] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => setNow(CLOCK_FORMAT.format(new Date()));
    tick();
    const timer = setInterval(tick, 20_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <span className="num text-xs text-muted" suppressHydrationWarning>
      {now ?? "—"}
    </span>
  );
}

/** Выход: чистит cookie сессии и возвращает на форму входа. */
export function LogoutButton({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function logout() {
    if (pending) return;
    setPending(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Сеть отвалилась — кука могла и не сброситься, но уводить владельца на
      // /login всё равно правильно: middleware перепроверит сессию.
    } finally {
      router.replace("/login");
      router.refresh();
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={logout}
      disabled={pending}
      className={cn(
        "flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm text-muted transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-50",
        compact ? "w-full" : "",
      )}
    >
      <LogOut aria-hidden className="size-4 shrink-0" />
      <span>{pending ? "Выходим…" : "Выйти"}</span>
    </button>
  );
}

export default Sidebar;
