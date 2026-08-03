import type { Metadata } from "next";
import Link from "next/link";
import { CalendarDays, Clock, Radar, Send, Target, TrendingUp, Users } from "lucide-react";
import { KpiCard } from "@/components/os/kpi-card";
import { Panel } from "@/components/os/panel";
import { EmptyState } from "@/components/os/empty-state";
import { SalesWorkspace } from "@/components/sales/sales-workspace";
import { formatKop } from "@/core/shared/money";
import { computeOverview, loadBoard } from "@/modules/sales/metrics";
import { countNewCandidates } from "@/modules/sales/leadgen/candidates";
import { countPendingDrafts } from "@/modules/sales/outreach/queue";
import { countUncertainPosts } from "@/modules/sales/content/calendar";

/**
 * Командный центр продаж.
 *
 * Все цифры считает код (`modules/sales/metrics`), как и в финансах: модель
 * здесь не участвует ни одним числом. Она понадобится в еженедельном разборе —
 * для формулировок, а не для арифметики.
 */

export const metadata: Metadata = { title: "Продажи — Business OS" };
export const dynamic = "force-dynamic";

export default async function SalesPage() {
  const [overview, board, newCandidates, pendingDrafts, uncertainPosts] = await Promise.all([
    computeOverview(),
    loadBoard(),
    countNewCandidates(),
    countPendingDrafts(),
    countUncertainPosts(),
  ]);
  const isEmpty = board.every((stage) => stage.deals.length === 0);

  return (
    <div className="space-y-6">
      <section className="flex items-end justify-between gap-4">
        <div>
          <p className="label-xs text-muted">Отдел</p>
          <h2 className="mt-2 text-xl font-medium text-fg">Продажи</h2>
        </div>
        <div className="flex gap-2">
          <Link
            href="/sales/leadgen"
            className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs text-fg transition-colors hover:border-accent"
          >
            <Radar aria-hidden className="size-3.5" />
            Лидоген
            {newCandidates > 0 && <span className="num text-muted">{newCandidates}</span>}
          </Link>
          <Link
            href="/sales/outreach"
            className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs text-fg transition-colors hover:border-accent"
          >
            <Send aria-hidden className="size-3.5" />
            Аутрич
            {pendingDrafts > 0 && <span className="num text-muted">{pendingDrafts}</span>}
          </Link>
          <Link
            href="/sales/content"
            className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs text-fg transition-colors hover:border-accent"
          >
            <CalendarDays aria-hidden className="size-3.5" />
            Контент
            {uncertainPosts > 0 && <span className="num text-warning">{uncertainPosts}</span>}
          </Link>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label="Активные сделки"
          value={String(overview.activeDeals)}
          hint={`${formatKop(overview.activeAmountKop)} потенциала`}
          icon={Target}
        />
        <KpiCard
          label="Взвешенный потенциал"
          value={formatKop(overview.weightedAmountKop)}
          hint="с поправкой на вероятность стадии"
          icon={TrendingUp}
          accent
        />
        <KpiCard label="Новых лидов за неделю" value={String(overview.newLeadsWeek)} icon={Users} />
        <KpiCard
          label="Касаний сегодня"
          value={String(overview.touchesToday)}
          hint={
            overview.staleDeals > 0
              ? `${overview.staleDeals} сделок без движения`
              : "все сделки в движении"
          }
          deltaTone={overview.staleDeals > 0 ? "warn" : "ok"}
          icon={Clock}
        />
      </div>

      <Panel
        title="Воронка"
        subtitle={
          isEmpty
            ? undefined
            : "Карточку можно перетащить в соседнюю колонку — проигрыш спросит причину. Клик открывает лида."
        }
      >
        {isEmpty ? (
          <EmptyState
            icon={TrendingUp}
            title="Сделок пока нет"
            description="Заведите лид и создайте по нему сделку — она появится в колонке «Новый»."
            note="Фаза 3 — Продажи"
          />
        ) : (
          <SalesWorkspace stages={board} />
        )}
      </Panel>
    </div>
  );
}
