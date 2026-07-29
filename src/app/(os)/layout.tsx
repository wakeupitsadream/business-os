import type { ReactNode } from "react";
import { MobileNav, Sidebar, Topbar } from "@/components/os/sidebar";

/**
 * Оболочка командного центра. За периметр отвечает middleware — сюда попадают
 * только авторизованные запросы, повторной проверки здесь нет.
 */
export default function OsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-bg">
      <Sidebar />

      <div className="md:pl-[220px]">
        <Topbar />
        {/* pb-24 на телефоне — запас под фиксированную нижнюю навигацию,
            иначе последний блок страницы оказывается под ней. */}
        <main className="mx-auto w-full max-w-6xl px-4 pt-5 pb-24 md:px-6 md:pt-6 md:pb-10">
          {children}
        </main>
      </div>

      <MobileNav />
    </div>
  );
}
