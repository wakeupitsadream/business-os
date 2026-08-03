import type { Metadata } from "next";
import Link from "next/link";
import { Activity, Banknote, Brain, CheckCircle, TrendingUp } from "lucide-react";
import { checkDatabase, describeDbFailure } from "@/core/db";
import { formatKop } from "@/core/shared/money";
import { collectHqOverview } from "@/modules/hq/overview";
import { EmptyState } from "@/components/os/empty-state";
import { llmConfigured } from "@/core/llm";
import { tgConfigured } from "@/core/telegram/bot";
import { KpiCard } from "@/components/os/kpi-card";
import { Panel } from "@/components/os/panel";
import { cn } from "@/core/shared/cn";

export const metadata: Metadata = { title: "HQ — Business OS" };

// Статус системы читается в момент запроса: закэшированная страница показывала
// бы «БД доступна» уже после того, как она легла.
export const dynamic = "force-dynamic";

interface CheckRow {
  label: string;
  ok: boolean;
  detail: string;
}

async function collectChecks(): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];

  // Каждая проверка в своём try: упавший вызов не должен утащить весь экран —
  // HQ нужен владельцу именно тогда, когда что-то сломалось.
  try {
    const db = await checkDatabase();
    rows.push({
      label: "База данных (Neon)",
      ok: db.ok,
      // Не сырой текст Prisma: в нём хост базы, а этот экран владелец
      // показывает на скриншотах, когда просит помощи.
      detail: db.ok ? "соединение есть" : describeDbFailure(db.kind),
    });
  } catch {
    rows.push({ label: "База данных (Neon)", ok: false, detail: "проверка не выполнена" });
  }

  try {
    const ok = llmConfigured();
    rows.push({
      label: "LLM-шлюзы",
      ok,
      detail: ok ? "ключи заданы" : "нет ключей POLZA_API_KEY / PROXYAPI_API_KEY",
    });
  } catch {
    rows.push({ label: "LLM-шлюзы", ok: false, detail: "проверка не выполнена" });
  }

  try {
    const ok = tgConfigured();
    rows.push({
      label: "Telegram-бот",
      ok,
      detail: ok ? "токен и прокси заданы" : "нет TELEGRAM_BOT_TOKEN",
    });
  } catch {
    rows.push({ label: "Telegram-бот", ok: false, detail: "проверка не выполнена" });
  }

  return rows;
}

function StatusRow({ label, ok, detail }: CheckRow) {
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span
        aria-hidden
        className={cn("mt-1.5 size-2 shrink-0 rounded-full", ok ? "bg-ok" : "bg-danger")}
      />
      <span className="min-w-0 flex-1 text-sm text-fg">{label}</span>
      <span
        className={cn("num max-w-[55%] truncate text-right text-xs", ok ? "text-ok" : "text-danger")}
        title={detail}
      >
        {detail}
      </span>
    </li>
  );
}

/** Статусы прогонов по-русски: экран читает владелец, а не разработчик. */
const RUN_STATUS: Record<string, string> = {
  RUNNING: "идёт",
  OK: "успешно",
  ERROR: "ошибка",
  CANCELLED: "отменён",
};

const MODULE_LABEL: Record<string, string> = {
  secretary: "Секретарь",
  finance: "Финансы",
  sales: "Продажи",
};

export default async function HqPage() {
  const [checks, hq] = await Promise.all([collectChecks(), collectHqOverview()]);
  const build = process.env.BUILD_SHA?.slice(0, 7) ?? "dev";
  const pending = checks.filter((c) => !c.ok).length;

  // Расход на модели показываем цветом только когда лимит задан: без него
  // «много» и «мало» определить не по чему.
  const spendKop = hq.llmSpendKop.value;
  const overBudget =
    hq.llmBudgetKop > 0 && spendKop !== null && spendKop >= hq.llmBudgetKop * 0.8;

  return (
    <div className="space-y-6">
      <section>
        <p className="label-xs text-muted">Командный центр</p>
        <h2 className="mt-2 text-xl font-medium text-fg">Обзор</h2>
        <p className="mt-1 text-sm text-muted">Сводка по всем отделам.</p>
        {hq.failed.length > 0 && (
          // Пустой блок молча выглядел бы как «дел нет», а это неправда.
          <p className="mt-2 text-xs text-danger">
            Не удалось собрать: {hq.failed.join(", ")}. Остальное на экране — настоящее.
          </p>
        )}
      </section>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label="Выручка, месяц"
          value={hq.revenueKop.value === null ? "—" : formatKop(hq.revenueKop.value)}
          icon={Banknote}
          hint={hq.revenueKop.hint}
        />
        <KpiCard
          label="Активные сделки"
          value={hq.activeDeals.value === null ? "—" : String(hq.activeDeals.value)}
          icon={TrendingUp}
          hint={hq.activeDeals.hint}
        />
        <KpiCard
          label="Задач на сегодня"
          value={hq.tasksToday.value === null ? "—" : String(hq.tasksToday.value)}
          icon={CheckCircle}
          hint={hq.tasksToday.hint}
        />
        <KpiCard
          label="Расходы на ИИ, день"
          value={spendKop === null ? "—" : formatKop(spendKop)}
          icon={Brain}
          hint={hq.llmSpendKop.hint}
          deltaTone={overBudget ? "danger" : undefined}
          delta={overBudget ? "близко к лимиту" : undefined}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Что происходило" flush>
          {hq.feed.length === 0 ? (
            <div className="px-4 py-6">
              <EmptyState
                icon={Activity}
                title="Событий пока нет"
                description="Здесь появятся сделки, платежи и всё, что делают агенты."
              />
            </div>
          ) : (
            <ul className="divide-y divide-line px-4 py-1">
              {hq.feed.map((item) => (
                <li key={item.id} className="flex items-start gap-3 py-2.5">
                  <span className="label-xs mt-0.5 w-16 shrink-0 text-muted">
                    {MODULE_LABEL[item.module] ?? item.module}
                  </span>
                  <span className="min-w-0 flex-1 text-sm text-fg">{item.title}</span>
                  <span className="num shrink-0 text-xs text-muted">{item.at}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Агенты" subtitle="Последние прогоны" flush>
          {hq.runs.length === 0 ? (
            <div className="px-4 py-6">
              <EmptyState
                icon={Brain}
                title="Агенты ещё не запускались"
                description="Прогоны появятся после первого разговора или крона."
              />
            </div>
          ) : (
            <ul className="divide-y divide-line px-4 py-1">
              {hq.runs.map((run) => (
                <li key={run.id} className="flex items-start gap-3 py-2.5">
                  <span
                    aria-hidden
                    className={cn(
                      "mt-1.5 size-2 shrink-0 rounded-full",
                      run.status === "ERROR" ? "bg-danger" : run.status === "OK" ? "bg-ok" : "bg-muted",
                    )}
                  />
                  <span className="min-w-0 flex-1 text-sm text-fg">
                    {run.agentKey}
                    {run.error && (
                      <span className="mt-0.5 block truncate text-xs text-danger" title={run.error}>
                        {run.error}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-xs text-muted">
                      {RUN_STATUS[run.status] ?? run.status}
                    </span>
                    <span className="num block text-xs text-muted">{run.startedAt}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel
        title="Статус системы"
        subtitle={
          pending === 0
            ? "Все подсистемы каркаса подключены."
            : `Не подключено подсистем: ${pending}. Переменные — в разделе «Настройки».`
        }
        flush
      >
        <ul className="divide-y divide-line px-4 py-1">
          {checks.map((row) => (
            <StatusRow key={row.label} {...row} />
          ))}
          <li className="flex items-center gap-3 py-2.5">
            <span aria-hidden className="mt-0 size-2 shrink-0 rounded-full bg-muted" />
            <span className="min-w-0 flex-1 text-sm text-fg">Версия сборки</span>
            <span className="num text-xs text-muted">{build}</span>
          </li>
        </ul>
      </Panel>
    </div>
  );
}
