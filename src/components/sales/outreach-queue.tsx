"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Copy, ExternalLink, X } from "lucide-react";
import { cn } from "@/core/shared/cn";

/**
 * Очередь черновиков.
 *
 * Кнопки «Отправить» здесь нет намеренно, и это видно из интерфейса: есть
 * «Скопировать», ссылка в мессенджер и отметка «Отправил». Владелец пишет
 * сам — система только помнит, что он написал, и двигает за этим воронку.
 *
 * Текст редактируется прямо в очереди. Правка сохраняется рядом с оригиналом:
 * следующие черновики учатся на ней, а владелец видит, насколько модель
 * попадает в его тон.
 */

const CHANNEL_LABEL: Record<string, string> = {
  TELEGRAM: "Telegram",
  WHATSAPP: "WhatsApp",
  EMAIL: "Почта",
  PHONE: "Звонок",
};

export interface DraftRow {
  id: string;
  leadId: string;
  leadName: string;
  city: string | null;
  channel: string;
  status: string;
  body: string;
  originalBody: string | null;
  reasoning: string | null;
  link: string | null;
  phone: string | null;
  aiScore: number | null;
  createdAt: string;
}

export function OutreachQueue({ drafts }: { drafts: DraftRow[] }) {
  const router = useRouter();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  function textOf(draft: DraftRow): string {
    return edits[draft.id] ?? draft.body;
  }

  async function act(draft: DraftRow, action: string): Promise<void> {
    setBusyId(draft.id);
    setError(null);
    try {
      const edited = edits[draft.id];
      const res = await fetch(`/api/sales/outreach/${draft.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          ...(edited && edited.trim() !== draft.body ? { editedBody: edited } : {}),
        }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? "Действие не удалось выполнить");
        return;
      }
      router.refresh();
    } catch {
      setError("Сеть недоступна");
    } finally {
      setBusyId(null);
    }
  }

  async function copy(draft: DraftRow): Promise<void> {
    try {
      await navigator.clipboard.writeText(textOf(draft));
      setCopied(draft.id);
      window.setTimeout(() => setCopied((c) => (c === draft.id ? null : c)), 2000);
    } catch {
      setError("Буфер обмена недоступен — выделите текст вручную");
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <p className="flex items-center gap-2 text-xs text-danger">
          <AlertTriangle aria-hidden className="size-3.5" />
          {error}
        </p>
      )}

      {drafts.map((draft) => (
        <article key={draft.id} className="rounded-lg border border-line p-3">
          <header className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm text-fg">
                <span className="truncate">{draft.leadName}</span>
                {draft.aiScore !== null && (
                  <span className="num shrink-0 rounded border border-line px-1.5 text-[11px] text-muted">
                    {draft.aiScore}
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-xs text-muted">
                {[CHANNEL_LABEL[draft.channel] ?? draft.channel, draft.city, draft.phone]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            {draft.status === "APPROVED" && (
              <span className="label-xs shrink-0 text-ok">одобрен</span>
            )}
          </header>

          <textarea
            value={textOf(draft)}
            onChange={(e) => setEdits((s) => ({ ...s, [draft.id]: e.target.value }))}
            rows={4}
            aria-label={`Сообщение для «${draft.leadName}»`}
            className="mt-2 w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-accent"
          />

          {draft.reasoning && <p className="mt-1 text-xs text-muted">{draft.reasoning}</p>}
          {draft.originalBody && (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-muted">Что предлагалось</summary>
              <p className="mt-1 text-xs text-muted">{draft.originalBody}</p>
            </details>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => void copy(draft)}
              className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-fg hover:border-accent"
            >
              <Copy aria-hidden className="size-3" />
              {copied === draft.id ? "Скопировано" : "Скопировать"}
            </button>

            {draft.link && (
              <a
                href={draft.link}
                target="_blank"
                rel="noreferrer noopener"
                className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-fg hover:border-accent"
              >
                <ExternalLink aria-hidden className="size-3" />
                Открыть диалог
              </a>
            )}

            <button
              type="button"
              disabled={busyId !== null}
              onClick={() => void act(draft, "sent")}
              className={cn(
                "flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-bg",
                "disabled:opacity-40",
              )}
            >
              <Check aria-hidden className="size-3" />
              Отправил
            </button>

            <button
              type="button"
              disabled={busyId !== null}
              onClick={() => void act(draft, "reject")}
              aria-label="Отклонить черновик"
              className="rounded-md px-2 py-1 text-xs text-muted hover:text-fg disabled:opacity-40"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

export default OutreachQueue;
