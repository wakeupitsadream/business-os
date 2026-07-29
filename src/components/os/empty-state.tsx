import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/core/shared/cn";

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  /** Честно: что здесь будет и когда. Пустой экран без объяснения читается
   *  как поломка. */
  description?: string;
  /** Техническая приписка внизу: «Фаза 2 — Финансы». */
  note?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  note,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-lg border border-dashed border-line px-6 py-12 text-center",
        className,
      )}
    >
      {Icon ? (
        <span className="mb-4 flex size-10 items-center justify-center rounded-lg border border-line bg-surface-2">
          <Icon aria-hidden className="size-5 text-muted" />
        </span>
      ) : null}

      <p className="text-sm font-medium text-fg">{title}</p>

      {description ? (
        <p className="mt-2 max-w-md text-sm leading-relaxed text-muted">{description}</p>
      ) : null}

      {note ? <p className="label-xs mt-4 text-muted">{note}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export default EmptyState;
