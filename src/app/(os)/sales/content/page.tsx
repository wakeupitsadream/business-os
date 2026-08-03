import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { Panel } from "@/components/os/panel";
import { ContentCalendar } from "@/components/sales/content-calendar";
import { loadCalendar, parseMonthKey } from "@/modules/sales/content/calendar";

/**
 * Календарь контента.
 *
 * Месяц живёт в адресе (?at=YYYY-MM), а не в состоянии компонента: страница
 * серверная и данные грузит сервер — при навигации состоянием пришлось бы
 * дублировать загрузку в клиенте, а так «назад» в браузере работает бесплатно.
 */

export const metadata: Metadata = { title: "Контент — Business OS" };
export const dynamic = "force-dynamic";

export default async function ContentPage({
  searchParams,
}: {
  searchParams: Promise<{ at?: string }>;
}) {
  const { at } = await searchParams;
  const now = new Date();
  const view = await loadCalendar(parseMonthKey(at, now), now);

  return (
    <div className="space-y-6">
      <section>
        <Link
          href="/sales"
          className="label-xs inline-flex items-center gap-1.5 text-muted transition-colors hover:text-fg"
        >
          <ArrowLeft aria-hidden className="size-3.5" />
          Продажи
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-fg">Контент</h1>
        <p className="mt-1 text-sm text-muted">
          Темы придумывает модель, даты и рубрики считает система. В канал пост уходит сам —
          но только тот, что вы одобрили и поставили на время.
        </p>
      </section>

      <Panel
        title={view.monthLabel}
        action={
          <span className="flex items-center gap-1">
            <Link
              href={`/sales/content?at=${view.prevKey}`}
              aria-label="Предыдущий месяц"
              className="rounded p-1 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <ChevronLeft aria-hidden className="size-4" />
            </Link>
            <Link
              href={`/sales/content?at=${view.nextKey}`}
              aria-label="Следующий месяц"
              className="rounded p-1 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <ChevronRight aria-hidden className="size-4" />
            </Link>
          </span>
        }
      >
        <ContentCalendar days={view.days} weekdays={view.weekdays} />
      </Panel>
    </div>
  );
}
