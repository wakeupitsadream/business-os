import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Настройка панели «Разработка».
 *
 * Всё читается из env, и главное свойство — терпимость к рукам: опечатка в
 * одной записи не должна ронять разбор целиком, а пустая переменная — это
 * «не настроено», а не ошибка.
 */

vi.mock("@/core/observability/logger", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

const { devRepos, devHealthChecks, githubPat } = await import("./config");

const SAVED = { ...process.env };

afterEach(() => {
  process.env = { ...SAVED };
});

describe("репозитории", () => {
  it("пустая переменная — пустой список, а не ошибка", () => {
    delete process.env.DEV_GITHUB_REPOS;
    expect(devRepos()).toEqual([]);
  });

  it("разбирает список с пробелами и раскладывает owner/repo", () => {
    process.env.DEV_GITHUB_REPOS = " wakeupitsadream/business-os , acme/site ";
    expect(devRepos()).toEqual([
      { owner: "wakeupitsadream", repo: "business-os", full: "wakeupitsadream/business-os" },
      { owner: "acme", repo: "site", full: "acme/site" },
    ]);
  });

  it("опечатка выкидывает только свою запись, не весь список", () => {
    process.env.DEV_GITHUB_REPOS = "просто-текст,acme/site";
    expect(devRepos().map((r) => r.full)).toEqual(["acme/site"]);
  });

  it("дубли схлопываются", () => {
    process.env.DEV_GITHUB_REPOS = "acme/site,acme/site";
    expect(devRepos()).toHaveLength(1);
  });
});

describe("health-чеки", () => {
  it("разбирает пары имя=URL", () => {
    process.env.DEV_HEALTH_CHECKS = "Agentus=https://agentus.space/api/health";
    expect(devHealthChecks()).toEqual([
      { name: "Agentus", url: "https://agentus.space/api/health" },
    ]);
  });

  it("запись без URL или с не-http-адресом пропускается", () => {
    process.env.DEV_HEALTH_CHECKS = "Кривой,Тоже=ftp://x,Живой=https://a.example/h";
    expect(devHealthChecks().map((c) => c.name)).toEqual(["Живой"]);
  });

  it("знак «равно» внутри URL не режет запись", () => {
    // Query-string с параметрами — обычное дело для health-роутов.
    process.env.DEV_HEALTH_CHECKS = "ОС=https://os.example/api/health?deep=1";
    expect(devHealthChecks()[0]?.url).toBe("https://os.example/api/health?deep=1");
  });
});

describe("токен", () => {
  it("пустая строка означает «не задан»", () => {
    process.env.GITHUB_PAT = "   ";
    expect(githubPat()).toBeUndefined();
  });
});
