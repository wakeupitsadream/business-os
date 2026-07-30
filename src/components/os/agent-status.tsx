import { cn } from "@/core/shared/cn";

export type AgentState = "active" | "idle" | "working" | "error" | "off";

export interface AgentStatusProps {
  state?: AgentState;
  /** Имя агента слева от статуса: «АСЯ». */
  name?: string;
  /** Своя подпись вместо стандартной (ACTIVE, IDLE, …). */
  label?: string;
  className?: string;
}

interface StateStyle {
  label: string;
  dot: string;
  text: string;
  border: string;
  /** Пульсирует только то, что происходит прямо сейчас: постоянная анимация
   *  у покоя и ошибки превращается в раздражающий фоновой мигающий шум. */
  pulse: boolean;
}

const STATES: Record<AgentState, StateStyle> = {
  active: { label: "ACTIVE", dot: "bg-ok", text: "text-ok", border: "border-ok/30", pulse: true },
  working: {
    label: "WORKING",
    dot: "bg-accent",
    text: "text-accent",
    border: "border-accent/40",
    pulse: true,
  },
  idle: {
    label: "IDLE",
    dot: "bg-muted",
    text: "text-muted",
    border: "border-line",
    pulse: false,
  },
  error: {
    label: "ERROR",
    dot: "bg-danger",
    text: "text-danger",
    border: "border-danger/40",
    pulse: false,
  },
  off: {
    label: "OFFLINE",
    dot: "bg-muted/50",
    text: "text-muted",
    border: "border-line",
    pulse: false,
  },
};

/** Бейдж состояния агента: «● ACTIVE». */
export function AgentStatus({ state = "active", name, label, className }: AgentStatusProps) {
  const style = STATES[state];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border bg-surface-2 px-2.5 py-1",
        style.border,
        className,
      )}
    >
      <span className="relative flex size-1.5 shrink-0">
        {style.pulse ? (
          <span
            aria-hidden
            className={cn("absolute inset-0 rounded-full animate-pulse-soft", style.dot)}
          />
        ) : null}
        <span className={cn("relative size-1.5 rounded-full", style.dot)} />
      </span>

      {name ? <span className="label-xs text-muted">{name}</span> : null}
      <span className={cn("label-xs", style.text)}>{label ?? style.label}</span>
    </span>
  );
}

export default AgentStatus;
