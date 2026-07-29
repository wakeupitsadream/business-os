import type { Metadata } from "next";
import { Banknote } from "lucide-react";
import { EmptyState } from "@/components/os/empty-state";
import { Panel } from "@/components/os/panel";

export const metadata: Metadata = { title: "Финансы — Business OS" };

export default function FinancePage() {
  return (
    <div className="space-y-6">
      <section>
        <p className="label-xs text-muted">Отдел</p>
        <h2 className="mt-2 text-xl font-medium text-fg">Финансы</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Деньги бизнеса и личные: операции, категории, импорт банковских выписок, синхронизация
          ЮKassa, метрики и месячный отчёт с рекомендациями.
        </p>
      </section>

      <Panel title="Что здесь будет">
        <ul className="space-y-2 text-sm text-muted">
          <li>— ввод расхода фразой: «потратил 3500 на бензин»;</li>
          <li>— импорт выписок (CSV и PDF) без дублей при повторном заходе;</li>
          <li>— поступления ЮKassa каждые 6 часов, комиссия отдельной операцией;</li>
          <li>— уровни дохода как руководства к действию (playbooks).</li>
        </ul>
      </Panel>

      <EmptyState
        icon={Banknote}
        title="Модуль появится в фазе 2"
        description="Сначала — Секретарь: без ежедневного использования каркаса модуль финансов строить рано."
        note="Фаза 2 — Финансы"
      />
    </div>
  );
}
