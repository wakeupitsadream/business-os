import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/core/db";
import { createAndParseBatch } from "./batch";
import { commitBatch } from "./commit";
import { rollbackBatch } from "./rollback";
import type { ClassifiedRow } from "./classify";
import { accountBalances } from "../metrics";
import { createTransaction } from "../transactions";
import { assertDisposableDatabase, liveDbEnabled } from "@/core/testing/live-db";

/**
 * Направление перевода при сведении двух ног.
 *
 * Тест живой и проверяет ЦИФРЫ, а не поля. Иначе смысла в нём нет: ошибка
 * направления не видна ни в доходах, ни в расходах, ни в прибыли — переводы
 * исключены из всех итогов, — и суммарный остаток тоже сходится. Разъезжаются
 * только остатки ОТДЕЛЬНЫХ счетов, и заметить это можно было единственным
 * способом: открыть банк и сверить.
 *
 * Своя фикстура, а не общая tbank-sample.csv: у той в tbank.test.ts закреплено
 * число строк, и дописывание сломало бы соседний тест.
 */

const FIXTURE = new URL("./fixtures/tbank-transfer.csv", import.meta.url);
const bytes = () => new Uint8Array(readFileSync(FIXTURE));

/** 100 000 ₽ — ровно столько уходит со счёта выписки в фикстуре. */
const AMOUNT = 10_000_000;
const SBER = "acc_sber_test";

async function balance(id: string): Promise<number> {
  const all = await accountBalances();
  return all.find((b) => b.id === id)?.balanceKop ?? 0;
}

describe.runIf(liveDbEnabled)("сведение перевода: направление", () => {
  let statementAccountId = "";
  let counterpartId = "";

  beforeEach(async () => {
    assertDisposableDatabase();
    await prisma.transaction.deleteMany({});
    await prisma.importBatch.deleteMany({});
    await prisma.account.deleteMany({ where: { id: SBER } });

    const main = await prisma.account.findFirstOrThrow({
      where: { id: { not: SBER } },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    statementAccountId = main.id;

    await prisma.account.create({
      data: { id: SBER, name: "Сбер", kind: "BANK_ACCOUNT", currency: "RUB" },
    });

    // Сначала пришла выписка «Сбера»: перевод виден там как ПОСТУПЛЕНИЕ.
    const income = await createTransaction({
      type: "INCOME",
      amountKop: AMOUNT,
      date: new Date("2026-07-10T07:00:00Z"),
      accountId: SBER,
      note: "Perevod na schet Sber",
      source: "IMPORT",
    });
    counterpartId = income.id;
  });

  /** Разбор выписки счёта-источника с решением «свести расходную ногу». */
  async function preview() {
    const batch = await createAndParseBatch({
      fileName: "tbank-transfer.csv",
      bytes: bytes(),
      accountId: statementAccountId,
    });
    const stored = await prisma.importBatch.findUniqueOrThrow({
      where: { id: batch.id },
      select: { parsedRows: true },
    });
    const rows = stored.parsedRows as unknown as ClassifiedRow[];

    const transfer = rows.find((r) => r.rowClass === "transfer");
    expect(transfer, "расходная нога обязана опознаться как перевод").toBeDefined();
    expect(transfer?.counterpartId).toBe(counterpartId);

    return {
      batchId: batch.id,
      fingerprint: batch.stats.fingerprint,
      decisions: rows.map((r) => ({
        index: r.index,
        include: true,
        mergeTransfer: r.rowClass === "transfer",
      })),
      acknowledgeWarnings: true,
    };
  }

  /** Разбирает выписку и сразу сводит. */
  async function importAndMerge() {
    const plan = await preview();
    await commitBatch(plan);
    return plan.batchId;
  }

  it("деньги уходят со счёта выписки и приходят на встречный, а не наоборот", async () => {
    const before = { main: await balance(statementAccountId), sber: await balance(SBER) };

    await importAndMerge();

    const after = { main: await balance(statementAccountId), sber: await balance(SBER) };

    // Владелец перевёл 100 000 ₽ СО счёта выписки НА «Сбер». До сведения это
    // было видно только со стороны «Сбера» — как поступление; после сведения
    // та же строка становится ногой перевода и остаток «Сбера» не меняется,
    // а счёт выписки наконец показывает уход денег.
    expect(after.main).toBe(before.main - AMOUNT);
    expect(after.sber).toBe(before.sber);

    // Ровно это и было сломано: источником всегда объявлялся счёт встречной
    // операции, поэтому на расходной ноге знаки менялись местами — счёт
    // выписки «получал» деньги, а «Сбер» их «отдавал».
    expect(after.main).toBeLessThan(before.main);
    expect(after.main).not.toBe(before.main + AMOUNT);
    expect(after.sber).not.toBe(before.sber - AMOUNT);
  });

  it("сведение убирает фантомную выручку из суммарного остатка", async () => {
    // До сведения перевод числился поступлением на «Сбер»: своих денег стало
    // как будто больше на 100 000 ₽. Сведение это исправляет — суммарный
    // остаток падает ровно на сумму перевода, потому что выручки такой не было.
    const totalBefore = (await accountBalances()).reduce((s, a) => s + a.balanceKop, 0);
    await importAndMerge();
    const totalAfter = (await accountBalances()).reduce((s, a) => s + a.balanceKop, 0);

    expect(totalAfter).toBe(totalBefore - AMOUNT);
  });

  it("сведённая нога перестаёт быть фантомной выручкой", async () => {
    await importAndMerge();

    const income = await prisma.transaction.count({
      where: { type: "INCOME", amountKop: AMOUNT },
    });
    expect(income).toBe(0);

    const merged = await prisma.transaction.findUniqueOrThrow({
      where: { id: counterpartId },
      select: { type: true, accountId: true, transferAccountId: true },
    });
    expect(merged.type).toBe("TRANSFER");
    // Строка переехала на счёт-ИСТОЧНИК: у перевода одна строка, и её
    // accountId — это «откуда».
    expect(merged.accountId).toBe(statementAccountId);
    expect(merged.transferAccountId).toBe(SBER);
  });

  it("откат возвращает и тип, и счёт", async () => {
    const before = { main: await balance(statementAccountId), sber: await balance(SBER) };
    const batchId = await importAndMerge();

    await rollbackBatch(batchId);

    const restored = await prisma.transaction.findUniqueOrThrow({
      where: { id: counterpartId },
      select: { type: true, accountId: true, transferAccountId: true },
    });
    expect(restored.type).toBe("INCOME");
    expect(restored.accountId).toBe(SBER);
    expect(restored.transferAccountId).toBeNull();

    // Без возврата счёта остаток разъехался бы уже ПОСЛЕ отмены импорта.
    expect(await balance(statementAccountId)).toBe(before.main);
    expect(await balance(SBER)).toBe(before.sber);
  });

  it("повторное сведение не затирает чужое направление", async () => {
    // Два предпросмотра, открытые ДО первого подтверждения: оба видят
    // поступление на «Сбере» и оба предлагают его свести. Второй коммит
    // обязан оставить операцию в покое — она уже перевод.
    const a = await preview();
    const b = await preview();

    await commitBatch(a);
    const first = await prisma.transaction.findUniqueOrThrow({
      where: { id: counterpartId },
      select: { type: true, accountId: true, transferAccountId: true },
    });

    await commitBatch(b);
    const second = await prisma.transaction.findUniqueOrThrow({
      where: { id: counterpartId },
      select: { type: true, accountId: true, transferAccountId: true },
    });

    expect(second).toEqual(first);
  });
});
