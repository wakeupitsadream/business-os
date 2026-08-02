"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@/core/shared/cn";
import { formatKop } from "@/core/shared/money";

/**
 * Канбан воронки.
 *
 * Drag-n-drop на нативном HTML5 API, без библиотеки. Колонок шесть, карточек у
 * одного владельца десятки — всё, что дала бы библиотека сверх этого
 * (виртуализация, вложенные списки, сенсоры), здесь не нужно, а вес и ещё одна
 * зависимость нужны всегда.
 *
 * Перенос идёт через `POST /api/sales/deals/:id/stage`, а не прямой записью:
 * там обязательная причина проигрыша, запись касания и время на стадии.
 */

export interface BoardDeal {
  id: string;
  title: string;
  leadId: string;
  leadName: string;
  city: string | null;
  amountMonthlyKop: number;
  daysInStage: number;
  isStale: boolean;
}

export interface BoardStage {
  id: string;
  name: string;
  probability: number;
  isWon: boolean;
  isLost: boolean;
  deals: BoardDeal[];
  totalKop: number;
}

const LOST_REASONS = [
  { value: "PRICE", label: "Дорого" },
  { value: "NO_NEED", label: "Не нужно" },
  { value: "COMPETITOR", label: "Ушли к конкуренту" },
  { value: "NO_ANSWER", label: "Не отвечают" },
  { value: "BAD_TIMING", label: "Не сейчас" },
  { value: "OTHER", label: "Другое" },
] as const;

export function PipelineBoard({
  stages,
  onOpenLead,
}: {
  stages: BoardStage[];
  onOpenLead?: (leadId: string) => void;
}) {
  const router = useRouter();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Сделка, которую тащат в «Проиграно»: ждём причину. */
  const [askReason, setAskReason] = useState<{ dealId: string; stageId: string } | null>(null);

  async function move(dealId: string, toStageId: string, lostReason?: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sales/deals/${dealId}/stage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toStageId, lostReason }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Не удалось перенести сделку");
        return;
      }
      setAskReason(null);
      router.refresh();
    } catch {
      setError("Сеть недоступна — сделка осталась на месте");
    } finally {
      setBusy(false);
    }
  }

  function onDrop(stage: BoardStage) {
    const dealId = dragging;
    setDragging(null);
    setOver(null);
    if (!dealId) return;

    if (stage.isLost) {
      // Причину спрашиваем ДО переноса: сервер всё равно откажет без неё, а
      // владельцу лучше увидеть вопрос, чем ошибку.
      setAskReason({ dealId, stageId: stage.id });
      return;
    }
    void move(dealId, stage.id);
  }

  return (
    <div className="space-y-3">
      {error && (
        <p className="flex items-center gap-2 text-xs text-danger">
          <AlertTriangle aria-hidden className="size-3.5" />
          {error}
        </p>
      )}

      <div className="flex gap-3 overflow-x-auto pb-2">
        {stages.map((stage) => (
          <div
            key={stage.id}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(stage.id);
            }}
            onDragLeave={() => setOver((s) => (s === stage.id ? null : s))}
            onDrop={() => onDrop(stage)}
            className={cn(
              "flex w-64 shrink-0 flex-col rounded-lg border bg-surface transition-colors",
              over === stage.id ? "border-accent" : "border-line",
            )}
          >
            <header className="border-b border-line px-3 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="label-xs text-muted">{stage.name}</h3>
                <span className="num text-xs text-muted">{stage.deals.length}</span>
              </div>
              <p className="num mt-1 text-xs text-fg">
                {formatKop(stage.totalKop)}
                {!stage.isWon && !stage.isLost && (
                  <span className="ml-1.5 text-muted">· {stage.probability}%</span>
                )}
              </p>
            </header>

            <ul className="flex-1 space-y-2 p-2">
              {stage.deals.map((deal) => (
                <li
                  key={deal.id}
                  draggable={!busy}
                  onDragStart={() => setDragging(deal.id)}
                  onDragEnd={() => setDragging(null)}
                  onClick={() => onOpenLead?.(deal.leadId)}
                  className={cn(
                    "cursor-grab rounded-md border bg-surface-2 p-2.5 text-xs transition-opacity active:cursor-grabbing",
                    dragging === deal.id ? "opacity-40" : "opacity-100",
                    // Застрявшая карточка — единственное место, где воронка сама
                    // просит внимания. Порог у каждой стадии свой.
                    deal.isStale ? "border-warn/50" : "border-line",
                  )}
                >
                  <p className="truncate font-medium text-fg">{deal.leadName}</p>
                  <p className="mt-0.5 truncate text-muted">{deal.title}</p>
                  <div className="mt-1.5 flex items-baseline justify-between gap-2">
                    <span className="num text-fg">{formatKop(deal.amountMonthlyKop)}</span>
                    <span className={cn("text-[11px]", deal.isStale ? "text-warn" : "text-muted")}>
                      {deal.daysInStage} дн.
                    </span>
                  </div>
                </li>
              ))}
              {stage.deals.length === 0 && (
                <li className="px-1 py-3 text-center text-[11px] text-muted">пусто</li>
              )}
            </ul>
          </div>
        ))}
      </div>

      {askReason && (
        <div className="rounded-lg border border-warn/40 bg-surface p-4">
          <p className="text-sm text-fg">Почему сделка проиграна?</p>
          <p className="mt-1 text-xs text-muted">
            Без причины не сохраним: по ней и видно, что чинить в продукте.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {LOST_REASONS.map((reason) => (
              <button
                key={reason.value}
                type="button"
                disabled={busy}
                onClick={() => void move(askReason.dealId, askReason.stageId, reason.value)}
                className="rounded-md border border-line px-2.5 py-1.5 text-xs text-fg hover:border-accent disabled:opacity-40"
              >
                {reason.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setAskReason(null)}
              className="rounded-md px-2.5 py-1.5 text-xs text-muted hover:text-fg"
            >
              Отмена
            </button>
          </div>
        </div>
      )}

      {busy && (
        <p className="flex items-center gap-2 text-xs text-muted">
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
          Переношу…
        </p>
      )}
    </div>
  );
}
