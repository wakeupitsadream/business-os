import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Banknote, TrendingDown, TrendingUp, Upload, Wallet } from "lucide-react";
import { KpiCard, type DeltaTone } from "@/components/os/kpi-card";
import { Panel } from "@/components/os/panel";
import { Breakdown } from "@/components/finance/breakdown";
import { Money, PrivacyProvider, PrivacyToggle } from "@/components/finance/privacy";
import { QuickEntry } from "@/components/finance/quick-entry";
import { RevenueChart } from "@/components/finance/revenue-chart";
import { TransactionFeed, type FeedRow } from "@/components/finance/transaction-feed";
import { InsightCards, type InsightCard } from "@/components/finance/insight-cards";
import { logWarn } from "@/core/observability/logger";
import { formatLocal } from "@/core/shared/time";
import { computeOverview, type FinanceOverview } from "@/modules/finance/metrics";
import { listTransactions } from "@/modules/finance/query";
import { prisma } from "@/core/db";
import { resolvePeriod } from "@/modules/finance/period";

export const metadata: Metadata = { title: "Финансы — Business OS" };

/**
 * Экран финансов. Считается на каждый запрос: устаревшая цифра дохода хуже
 * секунды ожидания — по ней принимают решения.
 */
export const dynamic = "force-dynamic";

export default async function FinancePage() {
  const data = await loadPage();

  if (!data) {
    return (
      <div className="space-y-6">
        <Header />
        <Panel title="База недоступна">
          <p className="text-sm text-muted">
            Финансы не могут показать цифры. Причина — в{" "}
            <code className="font-mono text-fg">/api/health</code>.
          </p>
        </Panel>
      </div>
    );
  }

  const { overview, feed, insights } = data;
  const { current } = overview;

  return (
    <PrivacyProvider>
      <div className="space-y-6">
        <Header
          action={
            <div className="flex items-center gap-2">
              <Link
                href="/finance/import"
                className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-xs text-muted transition-colors hover:text-fg"
              >
                <Upload aria-hidden className="size-3.5" />
                Импорт выписки
              </Link>
              <PrivacyToggle />
            </div>
          }
        />

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiCard
            label={`Доходы · ${overview.range.label}`}
            value={<Money kop={current.incomeKop} />}
            delta={formatPct(overview.revenueChangePct)}
            deltaTone={tone(overview.revenueChangePct, "more-is-better")}
            hint="к прошлому месяцу"
            icon={TrendingUp}
            accent
          />
          <KpiCard
            label="Расходы"
            value={<Money kop={current.expenseKop} />}
            delta={formatPct(overview.expenseChangePct)}
            deltaTone={tone(overview.expenseChangePct, "less-is-better")}
            hint="к прошлому месяцу"
            icon={TrendingDown}
          />
          <KpiCard
            label="Прибыль"
            value={<Money kop={current.profitKop} sign={current.profitKop > 0} />}
            delta={formatPct(overview.profitChangePct)}
            deltaTone={tone(overview.profitChangePct, "more-is-better")}
            hint="к прошлому месяцу"
            icon={Banknote}
          />
          <KpiCard
            label="Остаток на счетах"
            value={<Money kop={overview.totalBalanceKop} />}
            hint={runwayHint(overview.runwayMonths)}
            icon={Wallet}
          />
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
          <div className="space-y-6">
            <Panel title="Динамика по месяцам" subtitle="доходы, расходы и прибыль">
              <RevenueChart data={overview.series} />
            </Panel>

            <Panel title="Наблюдения" subtitle="цифры считает код, формулировки — модель">
              <InsightCards cards={insights} />
            </Panel>

            <Panel title="Последние операции" flush>
              <TransactionFeed rows={feed} />
            </Panel>
          </div>

          <div className="space-y-6">
            <Panel title="Записать операцию">
              <QuickEntry />
            </Panel>

            <Panel title="Расходы по категориям" subtitle={overview.range.label}>
              <Breakdown rows={overview.topExpenses} />
            </Panel>

            {overview.balances.length > 0 && (
              <Panel title="Счета">
                <ul className="space-y-2">
                  {overview.balances.map((account) => (
                    <li
                      key={account.id}
                      className="flex items-baseline justify-between gap-3 text-sm"
                    >
                      <span className="truncate text-fg">{account.name}</span>
                      <span className="num shrink-0 text-muted">
                        <Money kop={account.balanceKop} />
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
          </div>
        </div>
      </div>
    </PrivacyProvider>
  );
}

function Header({ action }: { action?: ReactNode }) {
  return (
    <section className="flex items-start justify-between gap-4">
      <div>
        <p className="label-xs text-muted">Отдел</p>
        <h2 className="mt-2 text-xl font-medium text-fg">Финансы</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Доходы, расходы и остатки. Периоды режутся по московским суткам, суммы считает база —
          цифры на экране совпадают с тем, что лежит в операциях.
        </p>
      </div>
      {action}
    </section>
  );
}

interface PageData {
  overview: FinanceOverview;
  feed: FeedRow[];
  insights: InsightCard[];
}

/**
 * Недоступность базы не должна отдавать пятисотку: экран показывает понятное
 * сообщение и ссылку на health — так же, как страница секретаря.
 */
async function loadPage(): Promise<PageData | null> {
  try {
    const now = new Date();
    const overview = await computeOverview(now);
    const rows = await listTransactions({ range: resolvePeriod("quarter", now) }, { limit: 12 });
    const insightRows = await prisma.insight.findMany({
      where: { status: "new" },
      orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
      take: 4,
      select: { id: true, severity: true, title: true, bodyMd: true, factsJson: true },
    });

    const feed: FeedRow[] = rows.map((t) => ({
      id: t.id,
      type: t.type,
      date: formatLocal(t.date).slice(0, 10),
      amountKop: t.amountKop,
      title: t.counterparty ?? t.note ?? t.category?.name ?? "Операция",
      category: t.category?.name ?? null,
      account: t.account.name,
      source: t.source,
    }));

    const insights: InsightCard[] = insightRows.map((row) => ({
      id: row.id,
      severity: row.severity,
      title: row.title,
      body: row.bodyMd,
      facts: readFacts(row.factsJson),
    }));

    return { overview, feed, insights };
  } catch (e) {
    logWarn("finance.page_unavailable", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

function formatPct(pct: number | null): string | undefined {
  if (pct === null) return undefined;
  const rounded = Math.round(pct * 10) / 10;
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${String(rounded).replace(".", ",")}%`;
}

function tone(pct: number | null, direction: "more-is-better" | "less-is-better"): DeltaTone {
  if (pct === null || pct === 0) return "neutral";
  const good = direction === "more-is-better" ? pct > 0 : pct < 0;
  return good ? "ok" : "warn";
}

/**
 * Подпись про runway. «∞» не рисуем: доход может кончиться, а бесконечность на
 * экране читается как обещание.
 */
function runwayHint(months: number | null): string {
  if (months === null) return "деньги не убывают";
  if (months < 1) return "меньше месяца при текущем расходе";
  return `${months.toFixed(1).replace(".", ",")} мес. при текущем расходе`;
}

/**
 * Числа-основания карточки. Хранятся вместе с ней, чтобы происхождение вывода
 * можно было проверить, — но это Json из базы, и доверять его форме нельзя.
 */
function readFacts(raw: unknown): Array<{ id: string; text: string }> {
  if (typeof raw !== "object" || raw === null) return [];
  const facts = (raw as { facts?: unknown }).facts;
  if (!Array.isArray(facts)) return [];

  return facts
    .filter((f): f is { id: string; text: string } => {
      if (typeof f !== "object" || f === null) return false;
      const record = f as Record<string, unknown>;
      return typeof record.id === "string" && typeof record.text === "string";
    })
    .slice(0, 10);
}
