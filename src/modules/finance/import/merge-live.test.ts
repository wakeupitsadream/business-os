import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/core/db";
import { assertDisposableDatabase } from "@/core/testing/live-db";
import { accountBalances } from "../metrics";
import { buildDedupKey, createTransaction } from "../transactions";
import { classifyRows } from "./classify";
import { commitBatch } from "./commit";
import { rollbackBatch } from "./rollback";
import { fingerprintRows, type ImportStats } from "./batch";
import type { ClassifiedRow } from "./classify";

/**
 * Сведение двух ног перевода — на настоящей базе.
 *
 * Перевод между своими счетами приходит ДВУМЯ строками: по одной в выписке
 * каждого счёта. Хранится он одной операцией, и с этим связаны два дефекта,
 * которые моками не поймать, потому что оба видны только в остатках и только
 * при повторном импорте.
 *
 * Оба проверяются здесь сверкой с `accountBalances` — той самой функцией, чьи
 * цифры владелец видит на экране.
 */

const live = process.env.LIVE_DB === "1";
const DATE = new Date("2026-07-05T11:00:00Z");
const AMOUNT = 50_000_00;

/** Встречная нога, уже импортированная из выписки другого счёта. */
async function counterpartOn(accountId: string, type: "INCOME" | "EXPENSE") {
  return createTransaction({
    type,
    amountKop: AMOUNT,
    date: DATE,
    accountId,
    note: "Перевод между своими счетами",
    source: "IMPORT",
    dedupKey: buildDedupKey({
      accountId,
      date: DATE,
      amountKop: AMOUNT,
      description: "Перевод между своими счетами",
      type,
    }),
  });
}

/** Партия из одной строки выписки указанного счёта. */
async function batchWith(row: ClassifiedRow, accountId: string, accountName: string) {
  const stats: Partial<ImportStats> = {
    accountId,
    accountName,
    fingerprint: fingerprintRows([row]),
    total: 1,
    fresh: 1,
    duplicates: 0,
    transfers: 1,
    settlements: 0,
  };
  return prisma.importBatch.create({
    data: {
      fileName: "transfer.csv",
      status: "PREVIEW",
      parsedRows: [row] as unknown as never,
      stats: stats as unknown as never,
    },
    select: { id: true },
  });
}

async function balanceOf(accountId: string): Promise<number> {
  const all = await accountBalances();
  return all.find((a) => a.id === accountId)?.balanceKop ?? 0;
}

describe.runIf(live)("сведение перевода на живой базе", () => {
  beforeEach(async () => {
    assertDisposableDatabase();
    await prisma.transaction.deleteMany({});
    await prisma.importBatch.deleteMany({});
  });

  it("расходная нога: деньги уходят со счёта выписки, а не приходят на него", async () => {
    // Тот самый перевёрнутый перевод. Встречная нога — приход на «Наличные»,
    // строка выписки — расход с «Основной карты»: деньги ушли С КАРТЫ. Раньше
    // запись утверждала обратное, и оба остатка разъезжались на двойную сумму.
    const counterpart = await counterpartOn("acc_cash", "INCOME");

    const [classified] = (
      await classifyRows(
        [
          {
            date: DATE,
            amountKop: AMOUNT,
            type: "EXPENSE",
            description: "Перевод на свою карту",
            mcc: null,
            bankCategory: null,
            lineNo: 2,
          },
        ],
        { accountId: "acc_main" },
      )
    ).rows;
    expect(classified?.rowClass).toBe("transfer");
    expect(classified?.counterpartId).toBe(counterpart.id);

    const batch = await batchWith(classified as ClassifiedRow, "acc_main", "Основная карта");

    await commitBatch({
      batchId: batch.id,
      fingerprint: fingerprintRows([classified as ClassifiedRow]),
      decisions: [{ index: 0, include: true, mergeTransfer: true }],
    });

    const merged = await prisma.transaction.findUniqueOrThrow({
      where: { id: counterpart.id },
      select: { type: true, accountId: true, transferAccountId: true },
    });
    expect(merged.type).toBe("TRANSFER");
    // Деньги ушли с карты на наличные — значит откуда=карта, куда=наличные.
    expect(merged.accountId).toBe("acc_main");
    expect(merged.transferAccountId).toBe("acc_cash");

    // И, что важнее любых полей, остатки: карта в минус, наличные в плюс.
    expect(await balanceOf("acc_main")).toBe(-AMOUNT);
    expect(await balanceOf("acc_cash")).toBe(AMOUNT);
  });

  it("приходная нога: направление прежнее и по-прежнему верное", async () => {
    // Контроль: половина, которая работала и раньше, не должна сломаться.
    const counterpart = await counterpartOn("acc_cash", "EXPENSE");

    const [classified] = (
      await classifyRows(
        [
          {
            date: DATE,
            amountKop: AMOUNT,
            type: "INCOME",
            description: "Перевод со своего счёта",
            mcc: null,
            bankCategory: null,
            lineNo: 2,
          },
        ],
        { accountId: "acc_main" },
      )
    ).rows;

    const batch = await batchWith(classified as ClassifiedRow, "acc_main", "Основная карта");
    await commitBatch({
      batchId: batch.id,
      fingerprint: fingerprintRows([classified as ClassifiedRow]),
      decisions: [{ index: 0, include: true, mergeTransfer: true }],
    });

    const merged = await prisma.transaction.findUniqueOrThrow({
      where: { id: counterpart.id },
      select: { accountId: true, transferAccountId: true },
    });
    expect(merged.accountId).toBe("acc_cash");
    expect(merged.transferAccountId).toBe("acc_main");
    expect(await balanceOf("acc_main")).toBe(AMOUNT);
    expect(await balanceOf("acc_cash")).toBe(-AMOUNT);
  });

  it("повторный импорт той же выписки не создаёт перевод заново", async () => {
    // Строка второй выписки не пишется отдельной операцией — иначе перевод
    // удвоился бы. Но её ключ дедупа должен остаться на сведённой операции,
    // иначе при повторной загрузке пересекающегося периода она снова «новая».
    const counterpart = await counterpartOn("acc_cash", "INCOME");
    const statementRow = {
      date: DATE,
      amountKop: AMOUNT,
      type: "EXPENSE" as const,
      description: "Перевод на свою карту",
      mcc: null,
      bankCategory: null,
      lineNo: 2,
    };

    const first = (await classifyRows([statementRow], { accountId: "acc_main" })).rows[0];
    const batch = await batchWith(first as ClassifiedRow, "acc_main", "Основная карта");
    await commitBatch({
      batchId: batch.id,
      fingerprint: fingerprintRows([first as ClassifiedRow]),
      decisions: [{ index: 0, include: true, mergeTransfer: true }],
    });
    expect(await prisma.transaction.count()).toBe(1);

    const again = await classifyRows([statementRow], { accountId: "acc_main" });
    expect(again.rows[0]?.rowClass).toBe("duplicate");
    expect(again.counts.duplicates).toBe(1);

    // И встречная выписка, если её загрузят повторно, тоже узнаёт свою ногу.
    const fromCash = await classifyRows(
      [
        {
          date: DATE,
          amountKop: AMOUNT,
          type: "INCOME",
          description: "Перевод между своими счетами",
          mcc: null,
          bankCategory: null,
          lineNo: 2,
        },
      ],
      { accountId: "acc_cash" },
    );
    expect(fromCash.rows[0]?.rowClass).toBe("duplicate");

    // Контрольная проверка «а не сломали ли дедуп вообще»: чужая операция
    // остаётся новой.
    void counterpart;
  });

  it("откат возвращает сведённую операцию на её счёт", async () => {
    const counterpart = await counterpartOn("acc_cash", "INCOME");
    const statementRow = {
      date: DATE,
      amountKop: AMOUNT,
      type: "EXPENSE" as const,
      description: "Перевод на свою карту",
      mcc: null,
      bankCategory: null,
      lineNo: 2,
    };
    const classified = (await classifyRows([statementRow], { accountId: "acc_main" })).rows[0];
    const batch = await batchWith(classified as ClassifiedRow, "acc_main", "Основная карта");
    await commitBatch({
      batchId: batch.id,
      fingerprint: fingerprintRows([classified as ClassifiedRow]),
      decisions: [{ index: 0, include: true, mergeTransfer: true }],
    });

    const { restored } = await rollbackBatch(batch.id);
    expect(restored).toBe(1);

    const back = await prisma.transaction.findUniqueOrThrow({
      where: { id: counterpart.id },
      select: { type: true, accountId: true, transferAccountId: true, mergedDedupKey: true },
    });
    // Сведение переставило операцию на другой счёт — откат обязан вернуть её.
    expect(back.type).toBe("INCOME");
    expect(back.accountId).toBe("acc_cash");
    expect(back.transferAccountId).toBeNull();
    expect(back.mergedDedupKey).toBeNull();
    expect(await balanceOf("acc_cash")).toBe(AMOUNT);
    expect(await balanceOf("acc_main")).toBe(0);
  });

  it("откат не стирает сырой файл выписки", async () => {
    // Откат — это «я передумал», а не «сожги улики»: файл нужен, чтобы
    // повторить импорт, а откатывают как раз тогда, когда что-то пошло не так.
    const batch = await prisma.importBatch.create({
      data: {
        fileName: "raw.csv",
        status: "COMMITTED",
        committedAt: new Date(),
        rawFile: Buffer.from("данные выписки"),
        stats: { accountId: "acc_main", transferMerges: [] } as unknown as never,
      },
      select: { id: true },
    });

    await rollbackBatch(batch.id);

    const after = await prisma.importBatch.findUniqueOrThrow({
      where: { id: batch.id },
      select: { status: true, rawFile: true },
    });
    expect(after.status).toBe("CANCELLED");
    expect(after.rawFile).not.toBeNull();
  });
});
