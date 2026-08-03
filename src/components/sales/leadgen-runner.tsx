"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Play } from "lucide-react";
import { cn } from "@/core/shared/cn";

/**
 * Постановка прогона лидогена в очередь.
 *
 * Кнопка называется «Поставить в очередь», а не «Запустить», и это не
 * придирка к словам: город идёт часами тиками крона, и «Запустить», после
 * которого страница выглядит так же, читался бы как «не сработало».
 */

export interface ConnectorOption {
  id: string;
  label: string;
}

export function LeadgenRunner({ connectors }: { connectors: ConnectorOption[] }) {
  const router = useRouter();
  const [connector, setConnector] = useState(connectors[0]?.id ?? "");
  const [rubric, setRubric] = useState("автосервис");
  const [city, setCity] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;

    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/sales/leadgen/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connector, rubric, city }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setMessage({ text: data.error ?? "Прогон не создан", ok: false });
        return;
      }
      setMessage({ text: "Прогон в очереди — первые кандидаты появятся в ближайшие минуты", ok: true });
      router.refresh();
    } catch {
      setMessage({ text: "Сеть недоступна — прогон не создан", ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {connectors.length > 1 && (
        <div className="flex gap-1 rounded-md border border-line p-1">
          {connectors.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setConnector(c.id)}
              className={cn(
                "flex-1 rounded px-3 py-1.5 text-xs transition-colors",
                connector === c.id ? "bg-surface-2 text-fg" : "text-muted hover:text-fg",
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <input
          value={rubric}
          onChange={(e) => setRubric(e.target.value)}
          placeholder="автосервис"
          aria-label="Что ищем"
          className="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-fg outline-none placeholder:text-muted focus:border-accent"
        />
        <input
          value={city}
          onChange={(e) => setCity(e.target.value)}
          placeholder="Екатеринбург"
          aria-label="Город"
          className="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-fg outline-none placeholder:text-muted focus:border-accent"
        />
      </div>

      <button
        type="submit"
        disabled={busy || rubric.trim().length < 2 || city.trim().length < 2}
        className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-bg transition-opacity disabled:opacity-40"
      >
        <Play aria-hidden className="size-4" />
        {busy ? "Ставлю в очередь…" : "Поставить в очередь"}
      </button>

      {message && (
        <p
          className={cn(
            "flex items-center gap-2 text-xs",
            message.ok ? "text-ok" : "text-danger",
          )}
        >
          {!message.ok && <AlertTriangle aria-hidden className="size-3.5" />}
          {message.text}
        </p>
      )}
    </form>
  );
}

export default LeadgenRunner;
