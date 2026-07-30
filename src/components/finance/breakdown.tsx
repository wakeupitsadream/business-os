"use client";

import { Money, usePrivacy } from "./privacy";

/**
 * Разбивка расходов по категориям.
 *
 * Полосой, а не круговой диаграммой: доли на «пироге» сравнивать глазом
 * трудно, а вопрос здесь ровно один — что съедает больше всего.
 */

export interface BreakdownRow {
  categoryId: string | null;
  categoryName: string;
  amountKop: number;
  count: number;
}

export function Breakdown({ rows }: { rows: BreakdownRow[] }) {
  const { hidden } = usePrivacy();

  if (rows.length === 0) {
    return <p className="text-sm text-muted">За этот месяц расходов ещё нет.</p>;
  }

  const max = Math.max(...rows.map((r) => r.amountKop), 1);
  const total = rows.reduce((acc, r) => acc + r.amountKop, 0);

  return (
    <ul className="space-y-3">
      {rows.map((row) => {
        const share = total > 0 ? Math.round((row.amountKop / total) * 100) : 0;
        return (
          <li key={row.categoryId ?? "none"}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate text-fg">{row.categoryName}</span>
              <span className="num shrink-0 text-muted">
                <Money kop={row.amountKop} />
                {!hidden && <span className="ml-2 text-xs">{share}%</span>}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${Math.max(2, Math.round((row.amountKop / max) * 100))}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default Breakdown;
