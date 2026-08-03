import { cn } from "@/core/shared/cn";

/**
 * Скелетоны загрузки.
 *
 * Экраны серверные, и до ответа сервера страница была пустой: на телефоне
 * через сотовую сеть это выглядит как «приложение не открылось». Скелетон
 * говорит «сейчас будет», не обещая при этом никаких чисел.
 *
 * Намеренно НЕ повторяет разметку экрана до пикселя: скелетон, притворяющийся
 * содержимым, при появлении настоящих данных даёт заметный скачок. Достаточно
 * передать форму — сколько блоков и какого примерно размера.
 */

function Bar({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-surface-2", className)} />;
}

/** Полоска заголовка раздела. */
export function SkeletonHeader() {
  return (
    <section className="space-y-2">
      <Bar className="h-3 w-24" />
      <Bar className="h-6 w-48" />
    </section>
  );
}

/** Ряд KPI-карточек. */
export function SkeletonKpis({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-md border border-line bg-surface p-4">
          <Bar className="h-3 w-20" />
          <Bar className="mt-3 h-6 w-24" />
          <Bar className="mt-2 h-2.5 w-16" />
        </div>
      ))}
    </div>
  );
}

/** Панель со списком строк. */
export function SkeletonPanel({ rows = 4 }: { rows?: number }) {
  return (
    <div className="rounded-md border border-line bg-surface">
      <div className="border-b border-line px-4 py-3">
        <Bar className="h-3.5 w-32" />
      </div>
      <div className="divide-y divide-line">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <Bar className="h-3 flex-1" />
            <Bar className="h-3 w-16 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Собранный экран: шапка, карточки, панель. Подходит большинству разделов. */
export function SkeletonScreen({ kpis = 4, rows = 4 }: { kpis?: number; rows?: number }) {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Загрузка">
      <SkeletonHeader />
      {kpis > 0 && <SkeletonKpis count={kpis} />}
      <SkeletonPanel rows={rows} />
    </div>
  );
}
