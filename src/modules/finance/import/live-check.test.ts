import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/core/db";
import { createAndParseBatch, reparseBatch } from "./batch";
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
  /** Партия первого импорта — её и откатывает тест отката. */
  let firstBatchId = "";

  beforeAll(async () => {
    // Первой строкой, до любого удаления: ниже идёт deleteMany без условий.
    assertDisposableDatabase();
    await prisma.transaction.deleteMany({});
    await prisma.importBatch.deleteMany({});
    const account = await prisma.account.findFirstOrThrow({ select: { id: true } });
    accountId = account.id;
  });

  /** Доход по всей базе — так же, как его считают метрики. */
  async function sumIncome(): Promise<number> {
    const [row] = await prisma.$queryRaw<Array<{ sum: bigint | null }>>`
      SELECT SUM("amountKop")::bigint AS sum FROM "Transaction" WHERE type = 'INCOME'
    `;
    return Number(row?.sum ?? 0);
  }

  /** Изменение остатка счёта операциями: приход минус расход и переводы с него. */
  async function accountDelta(id: string): Promise<number> {
    const [row] = await prisma.$queryRaw<Array<{ delta: bigint | null }>>`
      SELECT (
        COALESCE((SELECT SUM("amountKop") FROM "Transaction"
                  WHERE "accountId" = ${id} AND type = 'INCOME'), 0)
        - COALESCE((SELECT SUM("amountKop") FROM "Transaction"
                    WHERE "accountId" = ${id} AND type IN ('EXPENSE', 'TRANSFER')), 0)
        + COALESCE((SELECT SUM("amountKop") FROM "Transaction"
                    WHERE "transferAccountId" = ${id} AND type = 'TRANSFER'), 0)
      )::bigint AS delta
    `;
    return Number(row?.delta ?? 0);
  }

  /**
   * Два предпросмотра одного файла, открытых ДО того, как хоть один подтвердили.
   *
   * В конце месяца это обычное дело: владелец выгрузил выписку, открыл, отвлёкся,
   * выгрузил ещё раз. Обе партии разбирались на пустой базе и обе считают свои
   * строки новыми. Раньше вторая упиралась в уникальный индекс, вся транзакция
   * откатывалась, и вместо внятного ответа приходила 500-я; предпросмотр при
   * этом оставался прежним, поэтому повтор давал ту же ошибку — помогала только
   * повторная загрузка файла.
   */
  async function preview(fileName: string) {
    const batch = await createAndParseBatch({ fileName, bytes: bytes(), accountId });
    const stored = await prisma.importBatch.findUniqueOrThrow({
      where: { id: batch.id },
      select: { parsedRows: true },
    });
    const rows = stored.parsedRows as unknown as ClassifiedRow[];
    return {
      batchId: batch.id,
      fingerprint: batch.stats.fingerprint,
      decisions: rows.map((r) => ({ index: r.index, include: true })),
    };
  }

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
    const { batchId, stats, result } = await importAll();
    firstBatchId = batchId;

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

  it("две одинаковые строки в файле доезжают до базы обеими операциями", async () => {
    // Настоящая проверка нумерации повторов: моки не знают про уникальный
    // индекс (accountId, dedupKey), а именно он раньше делал выбор — либо
    // молча потерять вторую заправку, либо уронить весь коммит.
    // Описание латиницей намеренно: файл в cp1251, а дописать к нему кириллицу
    // из Node нечем — Buffer её в этой кодировке не соберёт. Для проверки
    // уникального индекса содержимое описания роли не играет, важно лишь то,
    // что обе строки совпадают по всем полям.
    const line =
      `"07.07.2026 21:00:00";"07.07.2026";"*4321";"OK";"-2 000,00";"RUB";"-2 000,00";"RUB";"0";"Auto";"5541";"AZS Rosneft";"0";"0";"2 000,00"`;
    const twice = Buffer.concat([
      readFileSync(FIXTURE),
      Buffer.from(`\n${line}\n${line}`, "ascii"),
    ]);

    const batch = await createAndParseBatch({
      fileName: "tbank-повторы.csv",
      bytes: new Uint8Array(twice),
      accountId,
    });
    const stored = await prisma.importBatch.findUniqueOrThrow({
      where: { id: batch.id },
      select: { parsedRows: true },
    });
    const rows = stored.parsedRows as unknown as ClassifiedRow[];
    const repeats = rows.filter((r) => r.description.includes("Rosneft"));

    expect(repeats).toHaveLength(2);
    expect(repeats[0]?.dedupKey).not.toBe(repeats[1]?.dedupKey);
    expect(repeats[1]?.repeatNote).toBeTruthy();

    const result = await commitBatch({
      batchId: batch.id,
      fingerprint: batch.stats.fingerprint,
      decisions: rows.map((r) => ({ index: r.index, include: true })),
      acknowledgeWarnings: true,
    });
    expect(result.created).toBe(2);

    const [row] = await prisma.$queryRaw<Array<{ n: bigint; sum: bigint }>>`
      SELECT COUNT(*)::bigint AS n, SUM("amountKop")::bigint AS sum
      FROM "Transaction" WHERE note LIKE '%Rosneft%'
    `;
    expect(Number(row?.n ?? 0)).toBe(2);
    expect(Number(row?.sum ?? 0)).toBe(400_000);
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

  it("поступление с ЮKassa не удваивает выручку, а уводит деньги со счёта ЮKassa", async () => {
    // Главная проверка §1.2, и сделать её можно только на живой базе: считаем
    // доход и остаток так же, как их считает система, — прямым SQL.
    await prisma.transaction.create({
      data: {
        type: "INCOME",
        amountKop: 4_500_000,
        date: new Date("2026-07-06T10:00:00Z"),
        accountId: "acc_yookassa",
        note: "Платёж клиента",
        source: "YOOKASSA",
        externalId: "pay_live_1",
      },
    });

    const incomeBefore = await sumIncome();
    const yooBefore = await accountDelta("acc_yookassa");

    const line = `"08.07.2026 12:00:00";"08.07.2026";"*4321";"OK";"45 000,00";"RUB";"45 000,00";"RUB";"0";"Popolneniya";"";"Perevod YOOKASSA";"0";"0";"45 000,00"`;
    const withSettlement = Buffer.concat([
      readFileSync(FIXTURE),
      Buffer.from(`\n${line}`, "ascii"),
    ]);

    const batch = await createAndParseBatch({
      fileName: "с-поступлением.csv",
      bytes: new Uint8Array(withSettlement),
      accountId,
    });
    const stored = await prisma.importBatch.findUniqueOrThrow({
      where: { id: batch.id },
      select: { parsedRows: true },
    });
    const rows = stored.parsedRows as unknown as ClassifiedRow[];
    const settlement = rows.find((r) => r.description.includes("YOOKASSA"));
    expect(settlement?.rowClass).toBe("settlement");

    await commitBatch({
      batchId: batch.id,
      fingerprint: batch.stats.fingerprint,
      decisions: rows.map((r) => ({ index: r.index, include: true })),
      acknowledgeWarnings: true,
    });

    // Доход не вырос: те же деньги уже посчитаны платежом клиента.
    expect(await sumIncome()).toBe(incomeBefore);
    // А со счёта ЮKassa они ушли.
    expect(await accountDelta("acc_yookassa")).toBe(yooBefore - 4_500_000);
  });

  it("повторный импорт того же поступления не создаёт второй перевод", async () => {
    // Перевод лежит на счёте ЮKassa, а не на счёте выписки, — поиск дублей
    // обязан его находить.
    const line = `"08.07.2026 12:00:00";"08.07.2026";"*4321";"OK";"45 000,00";"RUB";"45 000,00";"RUB";"0";"Popolneniya";"";"Perevod YOOKASSA";"0";"0";"45 000,00"`;
    const again = Buffer.concat([readFileSync(FIXTURE), Buffer.from(`\n${line}`, "ascii")]);

    const batch = await createAndParseBatch({
      fileName: "с-поступлением-2.csv",
      bytes: new Uint8Array(again),
      accountId,
    });
    const stored = await prisma.importBatch.findUniqueOrThrow({
      where: { id: batch.id },
      select: { parsedRows: true },
    });
    const rows = stored.parsedRows as unknown as ClassifiedRow[];
    const settlement = rows.find((r) => r.description.includes("YOOKASSA"));
    expect(settlement?.rowClass).toBe("duplicate");
  });

  it("откат удаляет ровно свои операции и позволяет импортировать заново", async () => {
    // Партия названа явно. «Первая попавшаяся подтверждённая» связывала этот
    // тест с составом соседних: стоило добавить рядом ещё один импорт, и
    // откатывалась чужая партия.
    const { deleted } = await rollbackBatch(firstBatchId);
    expect(deleted).toBe(6);
    expect(await prisma.transaction.count({ where: { importBatchId: firstBatchId } })).toBe(0);

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

describe.runIf(liveDbEnabled)("пересекающиеся предпросмотры", () => {
  let accountId = "";

  beforeAll(async () => {
    assertDisposableDatabase();
    await prisma.transaction.deleteMany({});
    await prisma.importBatch.deleteMany({});
    const account = await prisma.account.findFirstOrThrow({ select: { id: true } });
    accountId = account.id;
  });

  it("вторая партия не падает, а честно считает строки дублями", async () => {
    const mk = async () => {
      const batch = await createAndParseBatch({
        fileName: "tbank.csv",
        bytes: bytes(),
        accountId,
      });
      const stored = await prisma.importBatch.findUniqueOrThrow({
        where: { id: batch.id },
        select: { parsedRows: true },
      });
      const rows = stored.parsedRows as unknown as ClassifiedRow[];
      return {
        batchId: batch.id,
        fingerprint: batch.stats.fingerprint,
        decisions: rows.map((r) => ({ index: r.index, include: true })),
        acknowledgeWarnings: true,
      };
    };

    // Оба предпросмотра сделаны ДО первого подтверждения — оба считают строки новыми.
    const first = await mk();
    const second = await mk();

    const a = await commitBatch(first);
    expect(a.created).toBeGreaterThan(0);
    const afterFirst = await prisma.transaction.count();

    // Раньше здесь была 500-я из-за уникального индекса.
    const b = await commitBatch(second);
    expect(b.created).toBe(0);
    expect(b.skippedAsDuplicate).toBeGreaterThan(0);

    // Главное: ни одной лишней операции в базе.
    expect(await prisma.transaction.count()).toBe(afterFirst);
  });
});

describe.runIf(liveDbEnabled)("откат оставляет сырьё", () => {
  let accountId = "";

  beforeAll(async () => {
    assertDisposableDatabase();
    await prisma.transaction.deleteMany({});
    await prisma.importBatch.deleteMany({});
    const account = await prisma.account.findFirstOrThrow({ select: { id: true } });
    accountId = account.id;
  });

  async function importOnce() {
    const batch = await createAndParseBatch({ fileName: "tbank.csv", bytes: bytes(), accountId });
    const stored = await prisma.importBatch.findUniqueOrThrow({
      where: { id: batch.id },
      select: { parsedRows: true },
    });
    const rows = stored.parsedRows as unknown as ClassifiedRow[];
    await commitBatch({
      batchId: batch.id,
      fingerprint: batch.stats.fingerprint,
      decisions: rows.map((r) => ({ index: r.index, include: true })),
      acknowledgeWarnings: true,
    });
    return batch.id;
  }

  it("после отката файл выписки на месте", async () => {
    const batchId = await importOnce();
    await rollbackBatch(batchId);

    const after = await prisma.importBatch.findUniqueOrThrow({
      where: { id: batchId },
      select: { status: true, rawFile: true },
    });
    expect(after.status).toBe("CANCELLED");
    // Раньше та же транзакция стирала сырьё, и владелец, откативший импорт по
    // ошибке, снова шёл в банк за выпиской.
    expect(after.rawFile).not.toBeNull();
  });

  it("по сохранённому файлу разбирается новая партия", async () => {
    const batchId = await importOnce();
    await rollbackBatch(batchId);
    expect(await prisma.transaction.count()).toBe(0);

    const fresh = await reparseBatch(batchId);
    expect(fresh.id).not.toBe(batchId);

    // Строки классифицируются заново, а не берутся из старого разбора: в
    // сохранённых ключах зашит номер повторения по снимку базы, которого
    // больше нет.
    const stored = await prisma.importBatch.findUniqueOrThrow({
      where: { id: fresh.id },
      select: { parsedRows: true },
    });
    const rows = stored.parsedRows as unknown as ClassifiedRow[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.rowClass !== "duplicate")).toBe(true);

    await commitBatch({
      batchId: fresh.id,
      fingerprint: fresh.stats.fingerprint,
      decisions: rows.map((r) => ({ index: r.index, include: true })),
      acknowledgeWarnings: true,
    });
    expect(await prisma.transaction.count()).toBeGreaterThan(0);

    // Старая партия остаётся откатанной: история не переписывается задним числом.
    const old = await prisma.importBatch.findUniqueOrThrow({
      where: { id: batchId },
      select: { status: true },
    });
    expect(old.status).toBe("CANCELLED");
  });

  it("без файла даёт внятный отказ, а не пятисотую", async () => {
    const batchId = await importOnce();
    await rollbackBatch(batchId);
    // Ночная чистка забрала сырьё по возрасту.
    await prisma.importBatch.update({ where: { id: batchId }, data: { rawFile: null } });

    await expect(reparseBatch(batchId)).rejects.toThrow(/удал/i);
  });
});
