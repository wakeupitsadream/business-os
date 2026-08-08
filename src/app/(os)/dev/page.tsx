import type { Metadata } from "next";
import { Activity, CircleDot, Code, GitCommitHorizontal, GitPullRequest } from "lucide-react";
import { collectDevOverview } from "@/modules/dev/overview";
import { EmptyState } from "@/components/os/empty-state";
import { KpiCard } from "@/components/os/kpi-card";
import { Panel } from "@/components/os/panel";
import { cn } from "@/core/shared/cn";
import type { CiState } from "@/modules/dev/github";

export const metadata: Metadata = { title: "Разработка — Business OS" };

// Состояние CI и здоровье продуктов читаются в момент запроса: закэшированная
// страница показывала бы зелёный CI уже после того, как он упал.
export const dynamic = "force-dynamic";

/** Подпись и цвет состояния CI. Экран читает владелец, а не разработчик. */
const CI_BADGE: Record<CiState, { label: string; className: string }> = {
  green: { label: "CI зелёный", className: "text-ok" },
  red: { label: "CI красный", className: "text-danger" },
  running: { label: "CI идёт", className: "text-muted" },
  none: { label: "без проверок", className: "text-muted" },
  unknown: { label: "CI неясен", className: "text-muted" },
};

function CiBadge({ ci }: { ci: CiState | null }) {
  if (ci === null) return null;
  const badge = CI_BADGE[ci];
  return <span className={cn("num shrink-0 text-xs", badge.className)}>{badge.label}</span>;
}

export default async function DevPage() {
  const dev = await collectDevOverview();
  const nothingConfigured = !dev.githubConfigured && !dev.healthConfigured;

  return (
    <div className="space-y-6">
      <section>
        <p className="label-xs text-muted">Командный центр</p>
        <h2 className="mt-2 text-xl font-medium text-fg">Разработка</h2>
        <p className="mt-1 text-sm text-muted">
          Репозитории и здоровье продуктов. Панель только читает — запуска задач здесь нет.
        </p>
        {dev.failedRepos.length > 0 && (
          // Молча пропавший репозиторий выглядел бы как «там всё тихо».
          <p className="mt-2 text-xs text-danger">
            Не удалось прочитать:{" "}
            {dev.failedRepos.map((f) => `${f.repo} — ${f.error}`).join("; ")}.
          </p>
        )}
      </section>

      {nothingConfigured ? (
        <Panel>
          <EmptyState
            icon={Code}
            title="Раздел не настроен"
            description="Нужны переменные окружения: GITHUB_PAT и DEV_GITHUB_REPOS — для репозиториев, DEV_HEALTH_CHECKS — для health-чеков продуктов. Как их получить — docs/OWNER-CHECKLIST.md, раздел «Для Разработки»."
          />
        </Panel>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard
              label="Открытые PR"
              value={dev.openPrs.value === null ? "—" : String(dev.openPrs.value)}
              icon={GitPullRequest}
              hint={dev.openPrs.hint}
            />
            <KpiCard
              label="Красный CI"
              value={dev.redCi.value === null ? "—" : String(dev.redCi.value)}
              icon={Activity}
              hint={dev.redCi.hint}
              deltaTone={dev.redCi.value ? "danger" : undefined}
              delta={dev.redCi.value ? "нужно чинить" : undefined}
            />
            <KpiCard
              label="Открытые issues"
              value={dev.openIssues.value === null ? "—" : String(dev.openIssues.value)}
              icon={CircleDot}
              hint={dev.openIssues.hint}
            />
            <KpiCard
              label="Продукты"
              value={dev.productsUp.value === null ? "—" : String(dev.productsUp.value)}
              icon={Activity}
              hint={dev.productsUp.hint}
              deltaTone={
                dev.productsUp.value !== null && dev.health.some((h) => !h.ok)
                  ? "danger"
                  : undefined
              }
              delta={
                dev.productsUp.value !== null && dev.health.some((h) => !h.ok)
                  ? "есть лежащие"
                  : undefined
              }
            />
          </div>

          {dev.healthConfigured && (
            <Panel title="Продукты" subtitle="Health-чеки в момент открытия страницы" flush>
              <ul className="divide-y divide-line px-4 py-1">
                {dev.health.map((h) => (
                  <li key={h.name} className="flex items-start gap-3 py-2.5">
                    <span
                      aria-hidden
                      className={cn(
                        "mt-1.5 size-2 shrink-0 rounded-full",
                        h.ok ? "bg-ok" : "bg-danger",
                      )}
                    />
                    <span className="min-w-0 flex-1 text-sm text-fg">{h.name}</span>
                    <span
                      className={cn("num shrink-0 text-xs", h.ok ? "text-ok" : "text-danger")}
                      title={h.url}
                    >
                      {h.detail}
                      {h.latencyMs !== null ? ` · ${h.latencyMs} мс` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {dev.githubConfigured &&
            dev.repos.map((repo) => (
              <Panel key={repo.repo} title={repo.repo} flush>
                <div className="divide-y divide-line">
                  <div className="px-4 py-3">
                    <p className="label-xs text-muted">Pull requests</p>
                    {repo.prs.length === 0 ? (
                      <p className="mt-2 text-sm text-muted">Открытых нет.</p>
                    ) : (
                      <ul className="mt-1 divide-y divide-line">
                        {repo.prs.map((pr) => (
                          <li key={pr.number} className="flex items-start gap-3 py-2.5">
                            <span className="num mt-0.5 w-10 shrink-0 text-xs text-muted">
                              #{pr.number}
                            </span>
                            <span className="min-w-0 flex-1 text-sm text-fg">
                              <a
                                href={pr.url}
                                target="_blank"
                                rel="noreferrer"
                                className="hover:text-accent"
                              >
                                {pr.title}
                              </a>
                              {pr.draft && (
                                <span className="ml-2 text-xs text-muted">черновик</span>
                              )}
                              <span className="mt-0.5 block text-xs text-muted">
                                обновлён {pr.updatedAt}
                              </span>
                            </span>
                            <CiBadge ci={pr.ci} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="px-4 py-3">
                    <p className="label-xs text-muted">Последние коммиты</p>
                    <ul className="mt-1 divide-y divide-line">
                      {repo.commits.map((c) => (
                        <li key={c.sha} className="flex items-start gap-3 py-2">
                          <GitCommitHorizontal
                            aria-hidden
                            className="mt-0.5 size-4 shrink-0 text-muted"
                          />
                          <span className="min-w-0 flex-1 truncate text-sm text-fg" title={c.message}>
                            <a
                              href={c.url}
                              target="_blank"
                              rel="noreferrer"
                              className="hover:text-accent"
                            >
                              {c.message}
                            </a>
                          </span>
                          <span className="num shrink-0 text-xs text-muted">
                            {c.sha} · {c.at}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {repo.issues.length > 0 && (
                    <div className="px-4 py-3">
                      <p className="label-xs text-muted">Issues</p>
                      <ul className="mt-1 divide-y divide-line">
                        {repo.issues.map((i) => (
                          <li key={i.number} className="flex items-start gap-3 py-2">
                            <span className="num mt-0.5 w-10 shrink-0 text-xs text-muted">
                              #{i.number}
                            </span>
                            <span className="min-w-0 flex-1 text-sm text-fg">
                              <a
                                href={i.url}
                                target="_blank"
                                rel="noreferrer"
                                className="hover:text-accent"
                              >
                                {i.title}
                              </a>
                            </span>
                            <span className="num shrink-0 text-xs text-muted">{i.updatedAt}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </Panel>
            ))}

          {dev.githubConfigured && dev.repos.length === 0 && dev.failedRepos.length === 0 && (
            <Panel>
              <EmptyState
                icon={GitPullRequest}
                title="Репозитории не заданы"
                description="Токен есть, но список пуст. Добавьте DEV_GITHUB_REPOS — например, wakeupitsadream/business-os."
              />
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
