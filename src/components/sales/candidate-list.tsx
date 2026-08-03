"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Star, X } from "lucide-react";
import { cn } from "@/core/shared/cn";

/**
 * Разбор кандидатов лидогена.
 *
 * Две кнопки на строку — «В CRM» и «Мимо». Третьего действия здесь быть не
 * должно: список разбирают на бегу, и всё, что требует раздумья, надо
 * спрашивать отдельно — что и делает третий уровень дедупа.
 */

export interface CandidateRow {
  id: string;
  name: string;
  city: string | null;
  address: string | null;
  phone: string | null;
  site: string | null;
  rating: number | null;
  reviewsCount: number | null;
  score: number | null;
  hot: boolean;
  fitReason: string | null;
  suggestedPitch: string | null;
  source: string;
}

interface SimilarLead {
  leadId: string;
  name: string;
  city: string | null;
  similarity: number;
}

const SOURCE_LABEL: Record<string, string> = {
  yandex_geo: "Яндекс",
  two_gis: "2ГИС",
  stub: "демо",
};

export function CandidateList({ candidates }: { candidates: CandidateRow[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Кандидат, по которому третий уровень дедупа задал вопрос. */
  const [ask, setAsk] = useState<{ id: string; name: string; similar: SimilarLead[] } | null>(null);

  async function act(
    candidate: CandidateRow,
    body: Record<string, unknown>,
  ): Promise<void> {
    setBusyId(candidate.id);
    setError(null);
    try {
      const res = await fetch(`/api/sales/leadgen/candidates/${candidate.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as {
        error?: string;
        outcome?: string;
        similar?: SimilarLead[];
      };

      if (!res.ok) {
        setError(data.error ?? "Действие не удалось выполнить");
        return;
      }

      if (data.outcome === "needs_confirmation") {
        // Не ошибка, а вопрос: похожие названия автоматика не склеивает.
        setAsk({ id: candidate.id, name: candidate.name, similar: data.similar ?? [] });
        return;
      }

      setAsk(null);
      router.refresh();
    } catch {
      setError("Сеть недоступна");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-3">
      {error && (
        <p className="flex items-center gap-2 text-xs text-danger">
          <AlertTriangle aria-hidden className="size-3.5" />
          {error}
        </p>
      )}

      {ask && (
        <div className="rounded-lg border border-warn/40 bg-surface-2 p-4">
          <p className="text-sm text-fg">«{ask.name}» — это тот же лид?</p>
          <p className="mt-1 text-xs text-muted">
            Названия похожи, но телефоны разные. Склеить автоматически нельзя: две точки одной
            сети — это два лида, и разделить их потом будет уже нечем.
          </p>
          <ul className="mt-3 space-y-2">
            {ask.similar.map((s) => (
              <li key={s.leadId} className="flex items-center justify-between gap-3 text-xs">
                <span className="min-w-0 truncate text-fg">
                  {s.name}
                  {s.city ? <span className="text-muted"> · {s.city}</span> : null}
                </span>
                <button
                  type="button"
                  disabled={busyId !== null}
                  onClick={() =>
                    void act({ id: ask.id } as CandidateRow, {
                      action: "import",
                      mergeIntoLeadId: s.leadId,
                    })
                  }
                  className="shrink-0 rounded-md border border-line px-2.5 py-1 text-fg hover:border-accent disabled:opacity-40"
                >
                  Это он
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busyId !== null}
              onClick={() =>
                void act({ id: ask.id } as CandidateRow, { action: "import", asNewLead: true })
              }
              className="rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-bg disabled:opacity-40"
            >
              Другая компания — завести новый
            </button>
            <button
              type="button"
              onClick={() => setAsk(null)}
              className="rounded-md px-2.5 py-1.5 text-xs text-muted hover:text-fg"
            >
              Отмена
            </button>
          </div>
        </div>
      )}

      <ul className="divide-y divide-line">
        {candidates.map((c) => (
          <li key={c.id} className="flex items-start justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm text-fg">
                <span className="truncate">{c.name}</span>
                {c.score !== null && (
                  <span
                    className={cn(
                      "num shrink-0 rounded border px-1.5 text-[11px]",
                      c.hot ? "border-warn/60 text-warn" : "border-line text-muted",
                    )}
                    title={c.hot ? "Поток есть, онлайн-записи нет" : undefined}
                  >
                    {c.score}
                  </span>
                )}
              </p>
              <p className="mt-0.5 truncate text-xs text-muted">
                {[c.city, c.address].filter(Boolean).join(", ") || "адрес не указан"}
              </p>
              {c.fitReason && <p className="mt-1 text-xs text-fg">{c.fitReason}</p>}
              {c.suggestedPitch && (
                // Заготовка первой фразы, а не готовое сообщение: отправка
                // руками — в аутриче, здесь только повод для звонка.
                <p className="mt-0.5 text-xs text-muted">«{c.suggestedPitch}»</p>
              )}
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                {c.phone && <span className="num text-fg">{c.phone}</span>}
                {c.site && <span className="truncate">{c.site}</span>}
                {c.rating !== null && (
                  <span className="flex items-center gap-0.5">
                    <Star aria-hidden className="size-3" />
                    <span className="num">{c.rating}</span>
                    {c.reviewsCount !== null && <span className="num">({c.reviewsCount})</span>}
                  </span>
                )}
                <span>{SOURCE_LABEL[c.source] ?? c.source}</span>
              </p>
            </div>

            <div className="flex shrink-0 gap-1.5">
              <button
                type="button"
                disabled={busyId !== null}
                onClick={() => void act(c, { action: "import" })}
                className={cn(
                  "flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-fg",
                  "hover:border-accent disabled:opacity-40",
                )}
              >
                <Check aria-hidden className="size-3" />В CRM
              </button>
              <button
                type="button"
                disabled={busyId !== null}
                onClick={() => void act(c, { action: "skip" })}
                aria-label="Пропустить"
                className="rounded-md px-2 py-1 text-xs text-muted hover:text-fg disabled:opacity-40"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default CandidateList;
