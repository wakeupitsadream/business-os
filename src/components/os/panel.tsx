import type { ReactNode } from "react";
import { cn } from "@/core/shared/cn";

export interface PanelProps {
  /** Ярлык панели: мелкие моноширинные заглавные. */
  title?: string;
  /** Пояснение под заголовком — обычным шрифтом. */
  subtitle?: string;
  /** Действие в правом верхнем углу шапки (кнопка, ссылка, счётчик). */
  action?: ReactNode;
  /** Убрать внутренние отступы у тела — для таблиц и списков во всю ширину. */
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

/** Базовый контейнер интерфейса: тонкая рамка, плоская поверхность, без теней. */
export function Panel({
  title,
  subtitle,
  action,
  flush = false,
  className,
  bodyClassName,
  children,
}: PanelProps) {
  const hasHeader = Boolean(title ?? subtitle ?? action);

  return (
    <section className={cn("rounded-lg border border-line bg-surface", className)}>
      {hasHeader ? (
        <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title ? <h2 className="label-xs text-muted">{title}</h2> : null}
            {subtitle ? <p className="mt-1.5 text-sm text-muted">{subtitle}</p> : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </header>
      ) : null}

      <div className={cn(flush ? undefined : "p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

export default Panel;
