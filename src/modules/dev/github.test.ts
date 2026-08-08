import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Чтение GitHub.
 *
 * Клиент показывает свои ошибки владельцу на экране, поэтому главные тесты —
 * про то, что в текстах ошибок нет токена, и про сведение check-runs к одному
 * честному состоянию.
 */

const { summarizeChecks, loadRepoSnapshot } = await import("./github");

const PAT = "github_pat_SECRET_VALUE";
const REF = { owner: "acme", repo: "site", full: "acme/site" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("сведение check-runs", () => {
  it("нет проверок — none", () => {
    expect(summarizeChecks([])).toBe("none");
  });

  it("хоть один незавершённый — running", () => {
    expect(
      summarizeChecks([
        { status: "completed", conclusion: "success" },
        { status: "in_progress", conclusion: null },
      ]),
    ).toBe("running");
  });

  it("одно падение красит всё в красный", () => {
    expect(
      summarizeChecks([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "failure" },
      ]),
    ).toBe("red");
  });

  it("успех со скипами — зелёный", () => {
    expect(
      summarizeChecks([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "skipped" },
      ]),
    ).toBe("green");
  });

  it("отменённый прогон не зелёный и не красный", () => {
    // Обычно это прогон, вытесненный свежим пушем: зелёным показать — соврать,
    // красным — поднять ложную тревогу.
    expect(summarizeChecks([{ status: "completed", conclusion: "cancelled" }])).toBe("unknown");
  });
});

describe("снимок репозитория", () => {
  function routeMock(overrides: Partial<Record<string, unknown>> = {}) {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/pulls")) {
        return jsonResponse(
          overrides.pulls ?? [
            {
              number: 7,
              title: "Правка",
              draft: false,
              updated_at: "2026-08-05T10:00:00Z",
              html_url: "https://github.com/acme/site/pull/7",
              head: { sha: "abc1234def" },
            },
          ],
        );
      }
      if (url.includes("/check-runs")) {
        return jsonResponse({
          check_runs: [{ status: "completed", conclusion: "success" }],
        });
      }
      if (url.includes("/commits")) {
        return jsonResponse([
          {
            sha: "abc1234def5678",
            html_url: "https://github.com/acme/site/commit/abc1234",
            commit: {
              message: "Первая строка\n\nПодробности не нужны",
              committer: { date: "2026-08-05T09:00:00Z" },
            },
          },
        ]);
      }
      if (url.includes("/issues")) {
        return jsonResponse(
          overrides.issues ?? [
            {
              number: 1,
              title: "Баг",
              updated_at: "2026-08-05T08:00:00Z",
              html_url: "https://github.com/acme/site/issues/1",
            },
          ],
        );
      }
      throw new Error(`неожиданный запрос: ${url}`);
    });
  }

  it("собирает PR с CI, коммиты первой строкой и issues", async () => {
    routeMock();
    const snap = await loadRepoSnapshot(REF, PAT);

    expect(snap.prs[0]).toMatchObject({ number: 7, ci: "green" });
    expect(snap.commits[0]?.message).toBe("Первая строка");
    expect(snap.commits[0]?.sha).toBe("abc1234");
    expect(snap.issues[0]?.number).toBe(1);
  });

  it("PR, подмешанные GitHub-ом в issues, отсеиваются", async () => {
    // GitHub считает PR разновидностью issue: без фильтра каждый PR
    // показывался бы на панели дважды.
    routeMock({
      issues: [
        {
          number: 7,
          title: "Это PR",
          updated_at: "2026-08-05T08:00:00Z",
          html_url: "x",
          pull_request: {},
        },
        { number: 2, title: "Настоящий issue", updated_at: "2026-08-05T08:00:00Z", html_url: "y" },
      ],
    });
    const snap = await loadRepoSnapshot(REF, PAT);
    expect(snap.issues.map((i) => i.number)).toEqual([2]);
  });

  it("токен уходит в заголовок, а не в URL", async () => {
    routeMock();
    await loadRepoSnapshot(REF, PAT);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain(PAT);
    }
  });

  it("в тексте ошибки нет токена, а статус объяснён по-русски", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "Bad credentials" }, 401));

    const err = await loadRepoSnapshot(REF, PAT).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("401");
    expect((err as Error).message).not.toContain(PAT);
  });

  it("обрыв сети превращается в понятную ошибку без деталей транспорта", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed: ECONNREFUSED 140.82.121.6:443"));

    const err = await loadRepoSnapshot(REF, PAT).catch((e: Error) => e);

    expect((err as Error).message).toBe("нет соединения с GitHub");
  });
});
