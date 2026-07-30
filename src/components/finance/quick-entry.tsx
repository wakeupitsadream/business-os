"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { cn } from "@/core/shared/cn";

/**
 * Быстрый ввод операции.
 *
 * Три поля и кнопка. Всё, что можно не спрашивать, не спрашивается: счёт
 * подставляется по умолчанию, категория подбирается по описанию, дата —
 * сегодняшняя. Форма, требующая шести решений на чашку кофе, не заполняется
 * вовсе, и учёт умирает на второй неделе.
 */

export function QuickEntry() {
  const router = useRouter();
  const [direction, setDirection] = useState<"expense" | "income">("expense");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;

    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/finance/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction, amount, description }),
      });
      const data = (await res.json()) as { error?: string; category?: string | null };

      if (!res.ok) {
        setMessage({ text: data.error ?? "Не удалось записать", ok: false });
        return;
      }

      setAmount("");
      setDescription("");
      setMessage({
        text: data.category ? `Записано в «${data.category}»` : "Записано без категории",
        ok: true,
      });
      // Обновляем серверные данные страницы: KPI и список обязаны сойтись с
      // базой сразу, иначе владелец видит «записано», но старые цифры.
      router.refresh();
    } catch {
      setMessage({ text: "Сеть недоступна — операция не записана", ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="flex gap-1 rounded-md border border-line p-1">
        {(["expense", "income"] as const).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDirection(d)}
            className={cn(
              "flex-1 rounded px-3 py-1.5 text-xs transition-colors",
              direction === d ? "bg-surface-2 text-fg" : "text-muted hover:text-fg",
            )}
          >
            {d === "expense" ? "Расход" : "Доход"}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="3500"
          inputMode="decimal"
          aria-label="Сумма"
          className="num w-28 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-fg outline-none placeholder:text-muted focus:border-accent"
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="бензин"
          aria-label="На что"
          className="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-fg outline-none placeholder:text-muted focus:border-accent"
        />
      </div>

      <button
        type="submit"
        disabled={busy || amount.trim() === "" || description.trim() === ""}
        className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-bg transition-opacity disabled:opacity-40"
      >
        <Plus aria-hidden className="size-4" />
        {busy ? "Записываю…" : "Записать"}
      </button>

      {message && (
        <p className={cn("text-xs", message.ok ? "text-ok" : "text-danger")}>{message.text}</p>
      )}
      <p className="text-xs text-muted">
        Сумму можно писать как удобно: «3500», «3,5 тыс», «12к». Категорию подберём по описанию.
      </p>
    </form>
  );
}

export default QuickEntry;
