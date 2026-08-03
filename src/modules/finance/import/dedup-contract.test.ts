import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/core/db";
import { assertDisposableDatabase, liveDbEnabled } from "@/core/testing/live-db";
import { classifyRows } from "./classify";
import { createTransaction } from "../transactions";

/**
 * Контракт дедупа импорта на настоящей базе.
 *
 * Разбор утверждал, что ключ зависит от того, какие occurrence уже лежат в
 * базе, и потому дыра в нумерации задваивает операции. Это оказалось неверно:
 * occurrence считается по файлу (`seenSoFar`), а не по базе. Тесты ниже
 * закрепляют это: они прошли на прод-коде без единой правки и существуют,
 * чтобы следующая переделка дедупа не сломала свойства молча.
 */

const ACC = "probe-account";

async function seed() {
  await prisma.transaction.deleteMany({});
  await prisma.account.deleteMany({ where: { id: ACC } });
  await prisma.account.create({
    data: { id: ACC, name: "Проба", kind: "BANK_ACCOUNT", currency: "RUB" },
  });
}

function row(lineNo: number, description = "заправка") {
  return {
    lineNo,
    date: new Date("2026-08-01T09:00:00Z"),
    amountKop: 200_000,
    description,
    type: "EXPENSE" as const,
    raw: {},
  };
}

async function classify(rows: ReturnType<typeof row>[]) {
  return classifyRows(rows, { accountId: ACC });
}

/** Сколько строк из партии — новые (не дубли). */
function fresh(res: Awaited<ReturnType<typeof classify>>) {
  return res.rows.filter((r) => r.rowClass !== "duplicate").length;
}

async function commitFresh(res: Awaited<ReturnType<typeof classify>>) {
  for (const r of res.rows) {
    if (r.rowClass === "duplicate") continue;
    await createTransaction({
      accountId: ACC,
      type: "EXPENSE",
      amountKop: r.amountKop,
      note: r.description,
      date: new Date(r.date),
      dedupKey: r.dedupKey,
    });
  }
}

describe.runIf(liveDbEnabled)("проба дедупа из прода", () => {
  beforeEach(async () => {
    assertDisposableDatabase();
    await seed();
  });

  it("повторная загрузка того же файла не даёт новых строк", async () => {
    const file = [row(1), row(2), row(3)];
    await commitFresh(await classify(file));
    expect(await prisma.transaction.count()).toBe(3);

    expect(fresh(await classify(file))).toBe(0);
  });

  it("частичный повтор добавляет ровно недостающее", async () => {
    await commitFresh(await classify([row(1)]));
    // В базе одна, в файле две одинаковых — новой должна быть ровно одна.
    expect(fresh(await classify([row(1), row(2)]))).toBe(1);
  });

  it("дыра в нумерации: удалили среднюю, повтор файла восстанавливает одну", async () => {
    const file = [row(1), row(2), row(3)];
    await commitFresh(await classify(file));

    // Удаляем ровно одну строку — «дыра в нумерации» из утверждения разбора.
    const all = await prisma.transaction.findMany({ orderBy: { createdAt: "asc" } });
    await prisma.transaction.delete({ where: { id: all[1]!.id } });
    expect(await prisma.transaction.count()).toBe(2);

    const again = await classify(file);
    expect(fresh(again)).toBe(1);
    await commitFresh(again);
    // Задвоения нет: было три, стало три.
    expect(await prisma.transaction.count()).toBe(3);
  });

  it("откат партии и повторная загрузка не задваивают", async () => {
    const file = [row(1), row(2), row(3)];
    await commitFresh(await classify(file));
    await prisma.transaction.deleteMany({});

    const again = await classify(file);
    expect(fresh(again)).toBe(3);
    await commitFresh(again);
    expect(await prisma.transaction.count()).toBe(3);
  });

  it("файл, где операций стало БОЛЬШЕ, добавляет только прирост", async () => {
    await commitFresh(await classify([row(1), row(2)]));
    const bigger = [row(1), row(2), row(3), row(4)];
    expect(fresh(await classify(bigger))).toBe(2);
  });

  it("порядок строк в файле на ключи не влияет", async () => {
    const a = await classify([row(1, "заправка"), row(2, "заправка")]);
    const b = await classify([row(2, "заправка"), row(1, "заправка")]);
    expect(a.rows.map((r) => r.dedupKey).sort()).toEqual(b.rows.map((r) => r.dedupKey).sort());
  });
});

describe.runIf(liveDbEnabled)("проба: где дедуп мог бы сломаться по-настоящему", () => {
  beforeEach(async () => {
    assertDisposableDatabase();
    await seed();
  });

  it("одна операция, выгруженная с временем и без, даёт ОДИН ключ", async () => {
    // Инвариант из CLAUDE.md: день в ключе московский. 01.08 02:00 МСК — это
    // 31.07 23:00 UTC. Если ключ считать по UTC, банк, выгрузивший ту же
    // операцию датой без времени, получит другой ключ, и она задвоится.
    const withTime = {
      lineNo: 1,
      date: new Date("2026-07-31T23:00:00Z"),
      amountKop: 200_000,
      description: "заправка",
      type: "EXPENSE" as const,
      raw: {},
    };
    const dateOnly = { ...withTime, date: new Date("2026-08-01T00:00:00Z") };

    const a = await classify([withTime]);
    const b = await classify([dateOnly]);
    expect(a.rows[0]?.dedupKey).toBe(b.rows[0]?.dedupKey);
  });

  it("уникальный индекс не даёт записать один ключ дважды", async () => {
    // Защита на уровне базы от гонки двух одновременных подтверждений.
    const res = await classify([row(1)]);
    const key = res.rows[0]!.dedupKey;
    const make = () =>
      createTransaction({
        accountId: ACC,
        type: "EXPENSE",
        amountKop: 200_000,
        note: "заправка",
        date: new Date("2026-08-01T09:00:00Z"),
        dedupKey: key,
      });

    await make();
    await expect(make()).rejects.toThrow();
    expect(await prisma.transaction.count()).toBe(1);
  });
});
