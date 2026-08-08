import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Сводка панели «Разработка».
 *
 * Те же свойства, что у HQ: отказ одного репозитория не уносит остальные,
 * «не настроено» отличается от «ноль», и без токена никто никуда не ходит.
 */

const pat = vi.fn<() => string | undefined>(() => "tok");
const repos = vi.fn<() => Array<{ owner: string; repo: string; full: string }>>(() => []);
const checks = vi.fn<() => Array<{ name: string; url: string }>>(() => []);
const snapshot = vi.fn(async (..._a: unknown[]) => ({}) as unknown);
const probe = vi.fn(async (..._a: unknown[]) => ({}) as unknown);

vi.mock("./config", () => ({
  githubPat: () => pat(),
  devRepos: () => repos(),
  devHealthChecks: () => checks(),
}));
vi.mock("./github", () => ({
  loadRepoSnapshot: (...a: unknown[]) => snapshot(...a),
}));
vi.mock("./health", () => ({
  probeHealth: (...a: unknown[]) => probe(...a),
}));

const { collectDevOverview } = await import("./overview");

const REPO_A = { owner: "a", repo: "one", full: "a/one" };
const REPO_B = { owner: "b", repo: "two", full: "b/two" };

function snap(full: string, prCis: Array<string | null> = [], issues = 0) {
  return {
    repo: full,
    prs: prCis.map((ci, i) => ({
      number: i + 1,
      title: "t",
      draft: false,
      updatedAt: "x",
      url: "u",
      ci,
    })),
    commits: [],
    issues: Array.from({ length: issues }, (_, i) => ({
      number: i + 1,
      title: "i",
      updatedAt: "x",
      url: "u",
    })),
  };
}

beforeEach(() => {
  pat.mockReset().mockReturnValue("tok");
  repos.mockReset().mockReturnValue([]);
  checks.mockReset().mockReturnValue([]);
  snapshot.mockReset();
  probe.mockReset();
});

describe("без настройки", () => {
  it("без токена в GitHub никто не ходит, а KPI честно null", async () => {
    pat.mockReturnValue(undefined);
    repos.mockReturnValue([REPO_A]);

    const dev = await collectDevOverview();

    expect(snapshot).not.toHaveBeenCalled();
    expect(dev.githubConfigured).toBe(false);
    expect(dev.openPrs.value).toBeNull();
    expect(dev.openPrs.hint).toContain("GITHUB_PAT");
  });

  it("без health-чеков продукты — «не задано», а не «ноль из нуля»", async () => {
    const dev = await collectDevOverview();
    expect(dev.productsUp.value).toBeNull();
    expect(dev.healthConfigured).toBe(false);
  });
});

describe("изоляция отказов", () => {
  it("упавший репозиторий не уносит соседний", async () => {
    repos.mockReturnValue([REPO_A, REPO_B]);
    snapshot.mockImplementation(async (ref) => {
      if ((ref as { full: string }).full === "a/one") throw new Error("токен не принят (401)");
      return snap("b/two", ["green"], 2);
    });

    const dev = await collectDevOverview();

    expect(dev.repos.map((r) => r.repo)).toEqual(["b/two"]);
    expect(dev.failedRepos).toEqual([{ repo: "a/one", error: "токен не принят (401)" }]);
    expect(dev.openPrs.value).toBe(1);
  });
});

describe("цифры считает код", () => {
  it("KPI суммируются по репозиториям", async () => {
    repos.mockReturnValue([REPO_A, REPO_B]);
    snapshot.mockImplementation(async (ref) =>
      (ref as { full: string }).full === "a/one"
        ? snap("a/one", ["red", "green"], 1)
        : snap("b/two", ["red"], 2),
    );

    const dev = await collectDevOverview();

    expect(dev.openPrs.value).toBe(3);
    expect(dev.redCi.value).toBe(2);
    expect(dev.openIssues.value).toBe(3);
  });

  it("PR без запрошенного CI не зачисляется в красные", async () => {
    repos.mockReturnValue([REPO_A]);
    snapshot.mockResolvedValue(snap("a/one", [null, "red"]));

    const dev = await collectDevOverview();

    expect(dev.redCi.value).toBe(1);
  });

  it("здоровые продукты считаются из результатов проб", async () => {
    checks.mockReturnValue([
      { name: "A", url: "https://a/h" },
      { name: "B", url: "https://b/h" },
    ]);
    probe.mockImplementation(async (c) => ({
      name: (c as { name: string }).name,
      url: "u",
      ok: (c as { name: string }).name === "A",
      latencyMs: 10,
      detail: "",
    }));

    const dev = await collectDevOverview();

    expect(dev.productsUp.value).toBe(1);
    expect(dev.productsUp.hint).toContain("из 2");
  });
});
