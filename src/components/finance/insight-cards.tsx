"use client";

import { useState } from "react";
import { AlertTriangle, ChevronDown, Info, Sparkles } from "lucide-react";
import { cn } from "@/core/shared/cn";

/**
 * Карточки наблюдений.
 *
 * У каждой можно развернуть «расчёт» — числа, на которых она стоит. Это не
 * украшение: наблюдение о деньгах, происхождение которого нельзя проверить,
 * владелец либо примет на веру, либо перестанет читать. Первое опаснее.
 */

export interface InsightFact {
  id: string;
  text: string;
}

export interface InsightCard {
  id: string;
  severity: "INFO" | "WARNING" | "CRITICAL" | "OPPORTUNITY";
  title: string;
  body: string;
  facts: InsightFact[];
}

const TONE: Record<InsightCard["severity"], { border: string; text: string; icon: typeof Info }> = {
  INFO: { border: "border-line", text: "text-muted", icon: Info },
  WARNING: { border: "border-warn/40", text: "text-warn", icon: AlertTriangle },
  CRITICAL: { border: "border-danger/40", text: "text-danger", icon: AlertTriangle },
  OPPORTUNITY: { border: "border-ok/40", text: "text-ok", icon: Sparkles },
};

export function InsightCards({ cards }: { cards: InsightCard[] }) {
  if (cards.length === 0) {
    return (
      <p className="text-sm text-muted">
        Наблюдений пока нет — их нужно на чём-то строить. Появятся, когда накопится история
        операций хотя бы за пару месяцев.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {cards.map((card) => (
        <Card key={card.id} card={card} />
      ))}
    </div>
  );
}

function Card({ card }: { card: InsightCard }) {
  const [open, setOpen] = useState(false);
  const tone = TONE[card.severity];
  const Icon = tone.icon;

  return (
    <article className={cn("rounded-lg border bg-surface-2 p-3", tone.border)}>
      <div className="flex items-start gap-2">
        <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", tone.text)} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fg">{card.title}</p>
          <p className="mt-1 text-sm text-muted">{card.body}</p>

          {card.facts.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="label-xs mt-2 flex items-center gap-1 text-muted transition-colors hover:text-fg"
              >
                <ChevronDown
                  aria-hidden
                  className={cn("size-3 transition-transform", open && "rotate-180")}
                />
                расчёт
              </button>

              {open && (
                <ul className="mt-2 space-y-1 border-l border-line pl-3">
                  {card.facts.map((fact) => (
                    <li key={fact.id} className="text-xs text-muted">
                      {fact.text}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </article>
  );
}

export default InsightCards;
