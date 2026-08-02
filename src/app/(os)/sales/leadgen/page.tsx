import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Radar } from "lucide-react";
import { Panel } from "@/components/os/panel";
import { EmptyState } from "@/components/os/empty-state";
import { CandidateList } from "@/components/sales/candidate-list";
import { LeadgenRunner } from "@/components/sales/leadgen-runner";
import { configuredConnectors, usedToday } from "@/modules/sales/connectors";
import { listCandidates } from "@/modules/sales/leadgen/candidates";
import { listParseJobs, type ParseJobView } from "@/modules/sales/leadgen/jobs";

/**
 * Лидоген: прогоны и кандидаты.
 *
 * Вложенная страница раздела «Продажи», как импорт выписки у финансов: это
 * действие, а не отдел. В боковое меню не выносится.
 *
 * Кандидат — ещё не лид. Разделение видно и в интерфейсе: пока владелец не
 * нажал «В CRM», найденная компания не попадает ни в воронку, ни в счётчики.
 * Автоматический перенос сделал бы CRM свалкой справочника за одну ночь.
 */

export const metadata: Metadata = { title: "Лидоген — Business OS" };
export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<ParseJobView["status"], string> = {
  PENDING: "в очереди",
  RUNNING: "идёт",
  DONE: "завершён",
  FAILED: "ошибка",
  CANCELLED: "остановлен",
};

export default async function LeadgenPage() {
  const connectors = configuredConnectors().map((c) => ({ id: c.id, label: c.label }));

  const [jobs, candidates, quota] = await Promise.all([
    listParseJobs(10),
    listCandidates(),
    Promise.all(
      configuredConnectors().map(async (c) => ({
        label: c.label,
        used: await usedToday(c.id),
        cap: c.limits.dailyCap,
      })),
    ),
  ]);

  return (
    <div className="space-y-6">
      <section>
        <Link
          href="/sales"
          className="label-xs inline-flex items-center gap-1.5 text-muted transition-colors hover:text-fg"
        >
          <ArrowLeft aria-hidden className="size-3" />
          Продажи
        </Link>
        <h2 className="mt-2 text-xl font-medium text-fg">Лидоген</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Официальные API справочников, без скрапинга. Прогон идёт тиками фонового планировщика и
          продолжается после перезапуска с того места, где остановился.
        </p>
      </section>

      {connectors.length === 0 ? (
        <Panel title="Источники не настроены">
          <p className="text-sm text-muted">
            Ни один источник не настроен. Для Яндекс Geosearch нужен ключ{" "}
            <code className="font-mono text-fg">YANDEX_GEO_API_KEY</code>; демо-данные включаются{" "}
            <code className="font-mono text-fg">SALES_STUB_CONNECTOR=1</code>.
          </p>
        </Panel>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <Panel
            title="Кандидаты"
            subtitle={
              candidates.length > 0
                ? "«В CRM» заводит лида и склеивает его с существующим по телефону."
                : undefined
            }
          >
            {candidates.length === 0 ? (
              <EmptyState
                icon={Radar}
                title="Кандидатов пока нет"
                description="Поставьте прогон в очередь — найденные компании появятся здесь."
                note="Фаза 3 — Лидоген"
              />
            ) : (
              <CandidateList candidates={candidates} />
            )}
          </Panel>

          <div className="space-y-6">
            <Panel title="Новый прогон">
              <LeadgenRunner connectors={connectors} />
            </Panel>

            <Panel title="Суточный расход">
              <ul className="space-y-1.5 text-xs">
                {quota.map((q) => (
                  <li key={q.label} className="flex justify-between gap-2">
                    <span className="truncate text-muted">{q.label}</span>
                    <span className="num shrink-0 text-fg">
                      {q.used} / {q.cap}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-muted">
                Кап ниже реального лимита тарифа: наш день считается по UTC, а провайдер сбрасывает
                счётчик по своему времени.
              </p>
            </Panel>

            <Panel title="Прогоны">
              {jobs.length === 0 ? (
                <p className="text-xs text-muted">Прогонов ещё не было.</p>
              ) : (
                <ul className="space-y-2 text-xs">
                  {jobs.map((job) => (
                    <li key={job.id}>
                      <p className="truncate text-fg">
                        {job.rubric} · {job.city}
                      </p>
                      <p className="text-muted">
                        {STATUS_LABEL[job.status]} · найдено {job.stats.found}, новых{" "}
                        {job.stats.stored}
                      </p>
                      {job.error && <p className="text-danger">{job.error}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}
