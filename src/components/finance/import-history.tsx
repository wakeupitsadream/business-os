"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Undo2 } from "lucide-react";
import { cn } from "@/core/shared/cn";

/**
 * История импортов с откатом.
 *
 * Откат — не украшение, а условие, при котором импортом вообще можно
 * пользоваться: без него первая же криво разобранная выписка означает ручную
 * чистку двухсот строк в базе.
 */

export interface BatchRow {
  id: string;
  fileName: string;
  status: string;
  error: string | null;
  createdAt: string;
  transactions: number;
}

const STATUS_LABEL: Record<string, string> = {
  UPLOADED: "загружен",
  PARSING: "разбирается",
  PREVIEW: "ждёт подтверждения",
  NEEDS_REVIEW: "нужна проверка",
  COMMITTED: "импортирован",
  FAILED: "не разобран",
  CANCELLED: "отменён",
};

export function ImportHistory({ batches }: { batches: BatchRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function rollback(batch: BatchRow) {
    const confirmed = window.confirm(
      `Удалить ${batch.transactions} операций, импортированных из «${batch.fileName}»?`,
    );
    if (!confirmed) return;

    setBusy(batch.id);
    setError(null);
    try {
      const res = await fetch(`/api/finance/import/${batch.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "rollback" }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Откат не удался");
        return;
      }
      router.refresh();
    } catch {
      setError("Сеть недоступна — откат не выполнен");
    } finally {
      setBusy(null);
    }
  }

  if (batches.length === 0) {
    return <p className="text-sm text-muted">Выписки ещё не загружались.</p>;
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-xs text-danger">{error}</p>}

      {batches.map((batch) => (
        <div key={batch.id} className="rounded-md border border-line bg-surface-2 p-3">
          <p className="truncate text-sm text-fg">{batch.fileName}</p>
          <p className="label-xs mt-1 text-muted">
            {batch.createdAt} · {STATUS_LABEL[batch.status] ?? batch.status.toLowerCase()}
            {batch.transactions > 0 && ` · ${batch.transactions} операц.`}
          </p>
          {batch.error && <p className="mt-1 text-xs text-danger">{batch.error}</p>}

          {batch.status === "COMMITTED" && (
            <button
              type="button"
              onClick={() => void rollback(batch)}
              disabled={busy === batch.id}
              className={cn(
                "mt-2 flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-danger",
                busy === batch.id && "opacity-50",
              )}
            >
              <Undo2 aria-hidden className="size-3" />
              {busy === batch.id ? "Откатываю…" : "Откатить импорт"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export default ImportHistory;
