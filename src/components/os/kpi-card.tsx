import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/core/shared/cn";

export type DeltaTone = "ok" | "warn" | "danger" | "neutral";

export interface KpiCardProps {
  /** Что измеряем: «Выручка за месяц». */
  label: string;
  /** Готовое к показу значение. Форматирование — на стороне вызывающего
   *  (деньги через formatKop), карточка ничего не считает. */
  value: ReactNode;
  /** Изменение к прошлому периоду: «+12,4%», «−3 сделки». */
  delta?: string;
  deltaTone?: DeltaTone;
  /** Мелкая подсказка под значением: период, источник, оговорка. */
  hint?: string;
  icon?: LucideIcon;
  /** Подсветить карточку акцентом — только для действительно ключевой цифры. */
  accent?: boolean;
  className?: string;
}

const DELTA_TONE_CLASS: Record<DeltaTone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  neutral: "text-muted",
};

export function KpiCard({
  label,
  value,
  delta,
  deltaTone = "neutral",
  hint,
  icon: Icon,
  accent = false,
  className,
}: KpiCardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-surface p-4",
        accent ? "border-accent/40" : "border-line",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="label-xs text-muted">{label}</span>
        {Icon ? (
          <Icon
            aria-hidden
            className={cn("size-4 shrink-0", accent ? "text-accent" : "text-muted")}
          />
        ) : null}
      </div>

      <div
        className={cn(
          "num mt-3 text-3xl leading-none font-medium",
          accent ? "text-accent" : "text-fg",
        )}
      >
        {value}
      </div>

      {delta || hint ? (
        <div className="mt-2.5 flex items-baseline gap-2">
          {delta ? (
            <span className={cn("num text-xs", DELTA_TONE_CLASS[deltaTone])}>{delta}</span>
          ) : null}
          {hint ? <span className="truncate text-xs text-muted">{hint}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export default KpiCard;
