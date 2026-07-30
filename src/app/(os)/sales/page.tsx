import type { Metadata } from "next";
import { TrendingUp } from "lucide-react";
import { EmptyState } from "@/components/os/empty-state";
import { Panel } from "@/components/os/panel";

export const metadata: Metadata = { title: "Продажи — Business OS" };

export default function SalesPage() {
  return (
    <div className="space-y-6">
      <section>
        <p className="label-xs text-muted">Отдел</p>
        <h2 className="mt-2 text-xl font-medium text-fg">Продажи</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          CRM для Agentus: лиды, воронка сделок, касания, входящие заявки с сайта, черновики аутрича
          и контент-план.
        </p>
      </section>

      <Panel title="Что здесь будет">
        <ul className="space-y-2 text-sm text-muted">
          <li>— канбан-воронка сделок с причинами проигрыша;</li>
          <li>— заявки с agentus.space попадают в воронку за минуты;</li>
          <li>— лидоген только по официальным API (Яндекс, 2ГИС), без скрапинга;</li>
          <li>— персональные черновики писем на одобрение — отправка руками владельца.</li>
        </ul>
      </Panel>

      <EmptyState
        icon={TrendingUp}
        title="Модуль появится в фазе 3"
        description="Массовой автоматической рассылки не будет: только подготовленные черновики под ручную отправку."
        note="Фаза 3 — Продажи"
      />
    </div>
  );
}
