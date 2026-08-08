import { optionalEnv } from "@/core/env";
import { logWarn } from "@/core/observability/logger";

/**
 * Настройка панели «Разработка».
 *
 * Всё задаётся переменными окружения и всё необязательно: пустая переменная —
 * это «раздел не настроен», а не ошибка. Панель read-only по договорённости:
 * она показывает состояние репозиториев и продуктов, но ничего не запускает.
 */

export interface RepoRef {
  owner: string;
  repo: string;
  /** «owner/repo» — так репозиторий подписывается на экране. */
  full: string;
}

export interface HealthCheck {
  name: string;
  url: string;
}

/**
 * Токен GitHub. Достаточно fine-grained PAT только на чтение
 * (contents, pull requests, issues, checks) — панель ничего не пишет.
 */
export function githubPat(): string | undefined {
  return optionalEnv("GITHUB_PAT");
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Список репозиториев: DEV_GITHUB_REPOS="owner/repo, owner/other". */
export function devRepos(): RepoRef[] {
  const raw = optionalEnv("DEV_GITHUB_REPOS");
  if (!raw) return [];

  const seen = new Set<string>();
  const refs: RepoRef[] = [];
  for (const part of raw.split(",")) {
    const full = part.trim();
    if (!full) continue;
    if (!REPO_RE.test(full)) {
      // Опечатка в env не должна молча выкидывать репозиторий из панели так,
      // чтобы об этом нельзя было узнать, — след остаётся хотя бы в логе.
      logWarn("dev.repo_ignored", { entry: full });
      continue;
    }
    if (seen.has(full)) continue;
    seen.add(full);
    const slash = full.indexOf("/");
    refs.push({ owner: full.slice(0, slash), repo: full.slice(slash + 1), full });
  }
  return refs;
}

/**
 * Health-чеки продуктов: DEV_HEALTH_CHECKS="Agentus=https://…/health,ОС=https://…".
 * Имя — как показывать, URL — куда ходить. Запятая в имени не поддерживается.
 */
export function devHealthChecks(): HealthCheck[] {
  const raw = optionalEnv("DEV_HEALTH_CHECKS");
  if (!raw) return [];

  const checks: HealthCheck[] = [];
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      logWarn("dev.health_check_ignored", { entry });
      continue;
    }
    const name = entry.slice(0, eq).trim();
    const url = entry.slice(eq + 1).trim();
    if (!name || !/^https?:\/\//i.test(url)) {
      logWarn("dev.health_check_ignored", { entry });
      continue;
    }
    checks.push({ name, url });
  }
  return checks;
}
