import { formatLocal } from "@/core/shared/time";
import type { RepoRef } from "./config";

/**
 * Чтение состояния репозиториев через GitHub REST API.
 *
 * Клиент нарочно крошечный и только на чтение: четыре GET-запроса на
 * репозиторий, никакого SDK. Токен уходит в заголовок и НИКОГДА не попадает
 * в тексты ошибок — они показываются владельцу на экране как есть.
 */

const API_BASE = "https://api.github.com";

/** Таймаут одного запроса. GitHub обычно отвечает за сотни миллисекунд. */
const TIMEOUT_MS = 8_000;

/** Скольким PR сверху списка проверяем CI: по запросу на PR, без фанатизма. */
const CI_LIMIT = 5;

/** Сколько PR, коммитов и issues показываем на репозиторий. */
const LIST_LIMIT = 10;
const COMMITS_LIMIT = 5;

export type CiState = "green" | "red" | "running" | "none" | "unknown";

export interface DevPr {
  number: number;
  title: string;
  draft: boolean;
  updatedAt: string;
  url: string;
  /** null — CI для этого PR не запрашивался (он ниже CI_LIMIT в списке). */
  ci: CiState | null;
}

export interface DevCommit {
  sha: string;
  message: string;
  at: string;
  url: string;
}

export interface DevIssue {
  number: number;
  title: string;
  updatedAt: string;
  url: string;
}

export interface RepoSnapshot {
  repo: string;
  prs: DevPr[];
  commits: DevCommit[];
  issues: DevIssue[];
}

/** Категория вместо сырого статуса: текст виден владельцу на экране. */
function describeStatus(status: number): string {
  if (status === 401) return "токен не принят (401)";
  if (status === 403) return "нет доступа или исчерпан лимит запросов (403)";
  if (status === 404) return "репозиторий не найден или токен его не видит (404)";
  return `GitHub ответил ${status}`;
}

async function ghJson<T>(path: string, pat: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: {
        authorization: `Bearer ${pat}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "business-os-dev-panel",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") {
      throw new Error("GitHub не ответил за 8 секунд");
    }
    throw new Error("нет соединения с GitHub");
  }
  if (!res.ok) {
    res.body?.cancel().catch(() => undefined);
    throw new Error(describeStatus(res.status));
  }
  return (await res.json()) as T;
}

interface RawCheckRun {
  status: string;
  conclusion: string | null;
}

/**
 * Свести check-runs коммита к одному состоянию.
 *
 * «Отменён» не красный и не зелёный: обычно это прогон, вытесненный свежим
 * пушем. Показать его зелёным — соврать, красным — поднять ложную тревогу,
 * поэтому у него честное «unknown».
 */
export function summarizeChecks(runs: RawCheckRun[]): CiState {
  if (runs.length === 0) return "none";
  if (runs.some((r) => r.status !== "completed")) return "running";
  if (
    runs.some((r) =>
      ["failure", "timed_out", "startup_failure", "action_required"].includes(r.conclusion ?? ""),
    )
  ) {
    return "red";
  }
  if (runs.every((r) => ["success", "neutral", "skipped"].includes(r.conclusion ?? ""))) {
    return "green";
  }
  return "unknown";
}

interface RawPr {
  number: number;
  title: string;
  draft: boolean;
  updated_at: string;
  html_url: string;
  head: { sha: string };
}

interface RawCommit {
  sha: string;
  html_url: string;
  commit: { message: string; committer: { date: string } | null };
}

interface RawIssue {
  number: number;
  title: string;
  updated_at: string;
  html_url: string;
  /** У PR в выдаче issues есть это поле — по нему они и отсеиваются. */
  pull_request?: unknown;
}

/** Полный снимок одного репозитория. Бросает при первом отказе API. */
export async function loadRepoSnapshot(ref: RepoRef, pat: string): Promise<RepoSnapshot> {
  const base = `/repos/${ref.owner}/${ref.repo}`;

  const [rawPrs, rawCommits, rawIssues] = await Promise.all([
    ghJson<RawPr[]>(`${base}/pulls?state=open&per_page=${LIST_LIMIT}`, pat),
    ghJson<RawCommit[]>(`${base}/commits?per_page=${COMMITS_LIMIT}`, pat),
    // GitHub считает PR разновидностью issue и подмешивает их в выдачу.
    ghJson<RawIssue[]>(`${base}/issues?state=open&per_page=${LIST_LIMIT * 2}`, pat),
  ]);

  const ciBySha = new Map<string, CiState>();
  await Promise.all(
    rawPrs.slice(0, CI_LIMIT).map(async (pr) => {
      const data = await ghJson<{ check_runs: RawCheckRun[] }>(
        `${base}/commits/${pr.head.sha}/check-runs?per_page=50`,
        pat,
      );
      ciBySha.set(pr.head.sha, summarizeChecks(data.check_runs));
    }),
  );

  return {
    repo: ref.full,
    prs: rawPrs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      draft: pr.draft,
      updatedAt: formatLocal(new Date(pr.updated_at)),
      url: pr.html_url,
      ci: ciBySha.get(pr.head.sha) ?? null,
    })),
    commits: rawCommits.map((c) => ({
      sha: c.sha.slice(0, 7),
      // Тело коммита — простыня; на панели достаточно первой строки.
      message: c.commit.message.split("\n", 1)[0] ?? c.commit.message,
      at: c.commit.committer ? formatLocal(new Date(c.commit.committer.date)) : "—",
      url: c.html_url,
    })),
    issues: rawIssues
      .filter((i) => i.pull_request === undefined)
      .slice(0, LIST_LIMIT)
      .map((i) => ({
        number: i.number,
        title: i.title,
        updatedAt: formatLocal(new Date(i.updated_at)),
        url: i.html_url,
      })),
  };
}
