"use client";

import { cn } from "@/core/shared/cn";
import { Money } from "./privacy";

/**
 * Лента последних операций. Источник (Telegram, импорт, ЮKassa) показан
 * намеренно: когда цифра выглядит странно, первый вопрос — откуда она взялась.
 */

export interface FeedRow {
  id: string;
  type: "INCOME" | "EXPENSE" | "TRANSFER";
  date: string;
  amountKop: number;
  title: string;
  category: string | null;
  account: string;
  source: string;
}

const SOURCE_LABEL: Record<string, string> = {
  MANUAL: "вручную",
  SECRETARY: "Ася",
  TELEGRAM: "Telegram",
  IMPORT: "выписка",
  YOOKASSA: "ЮKassa",
  RECURRING: "регулярный",
};

export function TransactionFeed({ rows }: { rows: FeedRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="px-4 py-6 text-sm text-muted">
        Операций пока нет. Запиши первую в форме справа — или скажи Асе в Telegram.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-line">
      {rows.map((row) => (
        <li key={row.id} className="flex items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-fg">{row.title}</p>
            <p className="label-xs mt-0.5 truncate text-muted">
              {row.date} · {row.category ?? "без категории"} · {row.account} ·{" "}
              {SOURCE_LABEL[row.source] ?? row.source.toLowerCase()}
            </p>
          </div>
          <span
            className={cn(
              "num shrink-0 text-sm",
              row.type === "INCOME" ? "text-ok" : "text-fg",
            )}
          >
            {row.type === "INCOME" ? "+" : row.type === "EXPENSE" ? "−" : "⇄"}
            <Money kop={row.amountKop} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export default TransactionFeed;
