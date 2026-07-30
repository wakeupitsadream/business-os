"use client";

import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { cn } from "@/core/shared/cn";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Служебная пометка: действие ждёт подтверждения. */
  pending?: string[];
}

export function ChatPanel({ initial }: { initial: ChatMessage[] }) {
  const [messages, setMessages] = useState<ChatMessage[]>(initial);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send() {
    const text = draft.trim();
    if (text.length === 0 || busy) return;

    setDraft("");
    setError(null);
    setMessages((m) => [...m, { role: "user", content: text }]);
    setBusy(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = (await res.json()) as {
        reply?: string;
        error?: string;
        pendingApprovals?: string[];
      };

      if (!res.ok || !data.reply) {
        // Ошибку показываем текстом, а не молча: молчащий чат неотличим от
        // сломанного, и владелец будет ждать ответа, которого не будет.
        setError(data.error ?? "Не получилось ответить");
        return;
      }
      setMessages((m) => [
        ...m,
        { role: "assistant", content: data.reply as string, pending: data.pendingApprovals },
      ]);
    } catch {
      setError("Сеть недоступна");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {messages.length === 0 && (
          <p className="text-sm text-muted">
            Напиши что-нибудь — например, «напомни завтра в 10 позвонить в банк» или «что у меня
            по задачам».
          </p>
        )}

        {messages.map((m, i) => (
          <div
            key={i}
            className={cn(
              "rounded-lg border px-3 py-2 text-sm whitespace-pre-wrap",
              m.role === "user"
                ? "border-line bg-surface-2 text-fg"
                : "border-line/60 bg-surface text-fg",
            )}
          >
            <p className="label-xs mb-1 text-muted">{m.role === "user" ? "Я" : "Ася"}</p>
            {m.content}
            {m.pending && m.pending.length > 0 && (
              <p className="mt-2 rounded border border-warn/40 bg-warn/10 px-2 py-1 text-xs text-warn">
                Ждёт подтверждения: {m.pending.join(", ")}
              </p>
            )}
          </div>
        ))}

        {busy && <p className="text-sm text-muted">Ася думает…</p>}
        {error && (
          <p className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="mt-3 flex gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter отправляет, Shift+Enter переносит строку — как в мессенджерах.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder="Сообщение…"
          className="min-h-[44px] flex-1 resize-none rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-fg outline-none placeholder:text-muted focus:border-accent"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || draft.trim().length === 0}
          className="self-end rounded-lg bg-accent px-3 py-2 text-black transition disabled:opacity-40"
          aria-label="Отправить"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
