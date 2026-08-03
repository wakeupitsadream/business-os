import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/core/db";
import { createAndParseBatch } from "./batch";
import { commitBatch } from "./commit";
import { rollbackBatch } from "./rollback";
import { purgeImportArtifacts } from "./cleanup";
import type { ClassifiedRow } from "./classify";
import { assertDisposableDatabase, liveDbEnabled } from "@/core/testing/live-db";

/**
 * Сквозная проверка импорта на настоящем PostgreSQL. LIVE_DB=1.
 *
 * Здесь проверяется то, что моками не проверяется в принципе: уникальный
 * индекс по (accountId, dedupKey), атомарность транзакции и то, что суммы в
 * базе совпадают с файлом.
 */

const FIXTURE = new URL("./fixtures/tbank-sample.csv", import.meta.url);
const bytes = () => new Uint8Array(readFileSync(FIXTURE));

describe.runIf(liveDbEnabled)("импорт на живой базе", () => {
  let accountId = "";

  beforeAll(async () => {
    // Первой строкой, до любого удаления: ниже идёт deleteMany без условий.
    assertDisposableDatabase();
    await prisma.transaction.deleteMany({});
    await prisma.importBatch.deleteMany({});
    const account = await prisma.account.findFirstOrThrow({ select: { id: true } });
    accountId = account.id;
  });

  async function importAll(fileName = "tbank.csv") {
    const batch = await createAndParseBatch({ fileName, bytes: bytes(), accountId });
    const stored = await prisma.importBatch.findUniqueOrThrow({
      where: { id: batch.id },
      select: { parsedRows: true },
    });
    const rows = stored.parsedRows as unknown as ClassifiedRow[];

    const result = await commitBatch({
      batchId: batch.id,
      fingerprint: batch.stats.fingerprint,
      decisions: rows.map((r) => ({ index: r.index, include: true })),
      acknowledgeWarnings: true,
    });
    return { batchId: batch.id, stats: batch.stats, result };
  }

  it("выписка Т-Банка превращается в операции с верными суммами", async () => {
    const { stats, result } = await importAll();

    expect(result.created).toBe(6);
    expect(stats.bank).toBe("tbank");

    const [row] = await prisma.$queryRaw<Array<{ income: bigint | null; expense: bigint | null }>>`
      SELECT
        SUM("amountKop") FILTER (WHERE type = 'INCOME')::bigint  AS income,
        SUM("amountKop") FILTER (WHERE type = 'EXPENSE')::bigint AS expense
      FROM "Transaction" WHERE source = 'IMPORT'
    `;
    expect(Number(row?.income ?? 0)).toBe(stats.incomeKop);
    expect(Number(row?.expense ?? 0)).toBe(stats.expenseKop);
    // 3500 + 1250.50 + 1480 + 777 + 12000 = 19 007,50 ₽
    expect(Number(row?.expense ?? 0)).toBe(1_900_750);
  });

  it("категории проставились правилами, а не остались пустыми", async () => {
    const fuel = await prisma.transaction.findFirstOrThrow({
      where: { note: { contains: "Лукойл" } },
      select: { category: { select: { name: true } } },
    });
    expect(fuel.category?.name).toBe("Транспорт");
  });

  it("повторный импорт того же файла не создаёт ни одной новой операции", async () => {
    const before = await prisma.transaction.count();

    const batch = await createAndParseBatch({ fileName: "tbank.csv", bytes: bytes(), accountId });
    expect(batch.stats.fresh).toBe(0);
    expect(batch.stats.duplicates).toBe(6);

    const stored = await prisma.importBatch.findUniqueOrThrow({
      where: { id: batch.id },
      select: { parsedRows: true },
    });
    const rows = stored.parsedRows as unknown as ClassifiedRow[];
    const result = await commitBatch({
      batchId: batch.id,
      fingerprint: batch.stats.fingerprint,
      decisions: rows.map((r) => ({ index: r.index, include: true })),
      acknowledgeWarnings: true,
    });

    expect(result.created).toBe(0);
    expect(await prisma.transaction.count()).toBe(before);
  });

  it("повторное подтверждение того же импорта идемпотентно", async () => {
    const batch = await prisma.importBatch.findFirstOrThrow({
      where: { status: "COMMITTED" },
      select: { id: true, stats: true },
    });
    const stats = batch.stats as unknown as { fingerprint: string };

    const again = await commitBatch({
      batchId: batch.id,
      fingerprint: stats.fingerprint,
      decisions: [],
    });
    expect(again.alreadyCommitted).toBe(true);
  });

  it("устаревший предпросмотр подтвердить нельзя", async () => {
    // Вкладка, открытая вчера, не должна подтверждать импорт по строкам,
    // которых уже нет.
    const batch = await createAndParseBatch({ fileName: "stale.csv", bytes: bytes(), accountId });
    await expect(
      commitBatch({ batchId: batch.id, fingerprint: "0".repeat(64), decisions: [] }),
    ).rejects.toThrow(/устарел/);
  });

  it("разбор с непрочитанными строками требует явного подтверждения", async () => {
    // В фикстуре есть отказ и операция в обработке — обе не стали операциями,
    // и импортировать молча в такой ситуации нельзя.
    const batch = await createAndParseBatch({ fileName: "warn.csv", bytes: bytes(), accountId });
    expect(batch.status).toBe("NEEDS_REVIEW");

    await expect(
      commitBatch({ batchId: batch.id, fingerprint: batch.stats.fingerprint, decisions: [] }),
    ).rejects.toThrow(/предупреждения/);
  });

  it("откат удаляет ровно свои операции и позволяет импортировать заново", async () => {
    const committed = await prisma.importBatch.findFirstOrThrow({
      where: { status: "COMMITTED", transactions: { some: {} } },
      select: { id: true },
    });

    const { deleted } = await rollbackBatch(committed.id);
    expect(deleted).toBe(6);
    expect(await prisma.transaction.count({ where: { importBatchId: committed.id } })).toBe(0);

    // Тот же файл после отката снова целиком новый.
    const fresh = await createAndParseBatch({ fileName: "tbank.csv", bytes: bytes(), accountId });
    expect(fresh.stats.fresh).toBe(6);
  });

  it("чистка обнуляет сырые файлы старых импортов", async () => {
    const old = await prisma.importBatch.create({
      data: {
        fileName: "старая.csv",
        status: "COMMITTED",
        committedAt: new Date("2020-01-01T00:00:00Z"),
        rawFile: Buffer.from("данные"),
      },
      select: { id: true },
    });

    const result = await purgeImportArtifacts();
    expect(result.purgedCommitted).toBeGreaterThanOrEqual(1);

    const after = await prisma.importBatch.findUniqueOrThrow({
      where: { id: old.id },
      select: { rawFile: true },
    });
    expect(after.rawFile).toBeNull();

    // Повторный прогон уже ничего не трогает — иначе в логе каждую ночь
    // «удалено N» на одних и тех же записях.
    expect((await purgeImportArtifacts()).purgedCommitted).toBe(0);
  });
});
