import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Brain } from "lucide-react";
import { Panel } from "@/components/os/panel";
import { EmptyState } from "@/components/os/empty-state";
import { KpiCard } from "@/components/os/kpi-card";
import { formatKop } from "@/core/shared/money";
import { loadLlmSpend } from "@/modules/hq/llm-spend";
import { cn } from "@/core/shared/cn";

/**
 * Расходы на модели.
 *
 * Экран отвечает на два вопроса, которые задают в разном настроении: «сколько
 * уходит» и «на что именно». Второй важнее — суммарная цифра ничего не
 * подсказывает, а строка «скоринг кандидатов — 60% расхода» подсказывает сразу.
 */

export const metadata: Metadata = { title: "Расходы на ИИ — Business OS" };
export const dynamic = "force-dynamic";

export default async function LlmSpendPage() {
  const spend = await loadLlmSpend();
  const peak = Math.max(1, ...spend.lastDays.map((d) => d.costKop));

  return (
    <div className="space-y-6">
      <section>
        <Link
          href="/settings"
          className="label-xs inline-flex items-center gap-1.5 text-muted transition-colors hover:text-fg"
        >
          <ArrowLeft aria-hidden className="size-3.5" />
          Настройки
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-fg">Расходы на ИИ</h1>
        <p className="mt-1 text-sm text-muted">
          Считается по учтённым вызовам. Оценка по тарифам шлюзов — не счёт от провайдера.
        </p>
      </section>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <KpiCard
          label="Сегодня"
          value={formatKop(spend.todayKop)}
          icon={Brain}
          hint={
            spend.budgetKop > 0
              ? `лимит ${formatKop(spend.budgetKop)}`
              : "дневной лимит не задан"
          }
          delta={
            spend.budgetUsed !== null ? `${Math.round(spend.budgetUsed * 100)}% лимита` : undefined
          }
          deltaTone={spend.budgetUsed !== null && spend.budgetUsed >= 0.8 ? "danger" : "neutral"}
        />
        <KpiCard label="За 30 дней" value={formatKop(spend.monthKop)} hint="все вызовы" />
        <KpiCard
          label="Неудачных вызовов"
          value={String(spend.failures.length)}
          hint="за 30 дней, показаны последние"
          deltaTone={spend.failures.length > 0 ? "warn" : "neutral"}
        />
      </div>

      <Panel title="На что уходит" subtitle="За 30 дней, по статьям">
        {spend.byFeature.length === 0 ? (
          <EmptyState
            icon={Brain}
            title="Вызовов ещё не было"
            description="Здесь появится разбивка, как только агенты начнут работать."
          />
        ) : (
          <ul className="space-y-2">
            {spend.byFeature.map((f) => (
              <li key={f.feature}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm text-fg">{f.feature}</span>
                  <span className="num shrink-0 text-sm text-fg">{formatKop(f.costKop)}</span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                    <div
                      className="h-full rounded-full bg-accent"
                      style={{ width: `${Math.max(2, Math.round(f.share * 100))}%` }}
                    />
                  </div>
                  <span className="label-xs w-24 shrink-0 text-right text-muted">
                    {Math.round(f.share * 100)}% · {f.calls} выз.
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="По дням" subtitle="Две недели, сутки по вашему поясу">
        {spend.lastDays.length === 0 ? (
          <EmptyState icon={Brain} title="Данных пока нет" />
        ) : (
          <ul className="flex items-end gap-1" aria-label="Расход по дням">
            {spend.lastDays.map((d) => (
              <li key={d.day} className="flex-1" title={`${d.day}: ${formatKop(d.costKop)}`}>
                <div
                  className="rounded-t bg-accent/70"
                  style={{ height: `${Math.max(2, Math.round((d.costKop / peak) * 64))}px` }}
                />
                <span className="label-xs mt-1 block truncate text-center text-muted">
                  {d.day.slice(8)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {spend.failures.length > 0 && (
        <Panel title="Что не получилось" subtitle="Последние неудачные вызовы" flush>
          <ul className="divide-y divide-line px-4 py-1">
            {spend.failures.map((f, i) => (
              <li key={`${f.at}-${i}`} className="flex items-start gap-3 py-2.5">
                <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warn" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-fg">{f.feature}</span>
                  <span className={cn("block truncate text-xs text-muted")} title={f.error}>
                    {f.gateway} · {f.error}
                  </span>
                </span>
                <span className="num shrink-0 text-xs text-muted">{f.at}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
