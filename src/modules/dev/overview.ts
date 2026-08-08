import { devHealthChecks, devRepos, githubPat } from "./config";
import { loadRepoSnapshot, type RepoSnapshot } from "./github";
import { probeHealth, type HealthResult } from "./health";

/**
 * Сводка панели «Разработка».
 *
 * Тот же принцип, что в HQ: каждый репозиторий собирается отдельно, отказ
 * одного не уносит остальные, а «не знаем» не превращается в ноль. Панель
 * read-only: она ничего не запускает и ничего не пишет в GitHub.
 */

export interface DevKpi {
  /** null — считать не из чего: раздел не настроен или всё отказало. */
  value: number | null;
  hint: string;
}

export interface DevOverview {
  /** Задан ли GITHUB_PAT — без него блок репозиториев не собирается. */
  githubConfigured: boolean;
  repos: RepoSnapshot[];
  /** Репозитории, которые не собрались, с причиной — показываются как есть. */
  failedRepos: Array<{ repo: string; error: string }>;
  healthConfigured: boolean;
  health: HealthResult[];
  openPrs: DevKpi;
  redCi: DevKpi;
  openIssues: DevKpi;
  productsUp: DevKpi;
}

export async function collectDevOverview(): Promise<DevOverview> {
  const pat = githubPat();
  const repoRefs = devRepos();
  const checks = devHealthChecks();

  const repos: RepoSnapshot[] = [];
  const failedRepos: Array<{ repo: string; error: string }> = [];

  type RepoResult = { snap: RepoSnapshot } | { repo: string; error: string };
  const snapshotsPromise: Promise<RepoResult[]> = pat
    ? Promise.all(
        repoRefs.map(async (ref): Promise<RepoResult> => {
          try {
            return { snap: await loadRepoSnapshot(ref, pat) };
          } catch (e) {
            return { repo: ref.full, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      )
    : Promise.resolve([]);

  const [snapshotResults, health] = await Promise.all([
    snapshotsPromise,
    Promise.all(checks.map((c) => probeHealth(c))),
  ]);

  for (const r of snapshotResults) {
    if ("snap" in r) repos.push(r.snap);
    else failedRepos.push(r);
  }

  const githubUsable = Boolean(pat) && repoRefs.length > 0 && repos.length > 0;

  const openPrs: DevKpi = githubUsable
    ? {
        value: repos.reduce((sum, r) => sum + r.prs.length, 0),
        hint: `в ${repos.length} репо`,
      }
    : { value: null, hint: pat ? "репозитории не собрались" : "GITHUB_PAT не задан" };

  // Красный CI считается только по PR, у которых он реально запрашивался:
  // непроверенные не зачисляются ни в красные, ни в зелёные.
  const redCi: DevKpi = githubUsable
    ? {
        value: repos.reduce((sum, r) => sum + r.prs.filter((p) => p.ci === "red").length, 0),
        hint: "PR с падающими проверками",
      }
    : { value: null, hint: "нет данных" };

  const openIssues: DevKpi = githubUsable
    ? {
        value: repos.reduce((sum, r) => sum + r.issues.length, 0),
        hint: "открытых issues",
      }
    : { value: null, hint: "нет данных" };

  const productsUp: DevKpi =
    checks.length > 0
      ? {
          value: health.filter((h) => h.ok).length,
          hint: `из ${checks.length} отвечают`,
        }
      : { value: null, hint: "DEV_HEALTH_CHECKS не задан" };

  return {
    githubConfigured: Boolean(pat),
    repos,
    failedRepos,
    healthConfigured: checks.length > 0,
    health,
    openPrs,
    redCi,
    openIssues,
    productsUp,
  };
}
