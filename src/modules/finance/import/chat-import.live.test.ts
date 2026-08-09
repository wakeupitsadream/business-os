import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/core/db";
import { assertDisposableDatabase, liveDbEnabled } from "@/core/testing/live-db";
import { startChatImport, confirmChatImport, cancelChatImport } from "./telegram-import";

const FIXTURE = new URL("./fixtures/tbank-sample.csv", import.meta.url);

describe.runIf(liveDbEnabled)("импорт из чата на живой базе", () => {
  beforeAll(async () => {
    assertDisposableDatabase();
    await prisma.transaction.deleteMany({});
    await prisma.importBatch.deleteMany({});
  });

  it("файл из чата проходит весь путь до записанных операций", async () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const preview = await startChatImport({ fileName: "выписка.csv", bytes });

    expect(preview.text).toContain("Т-Банк");
    expect(preview.buttons[0]).toHaveLength(2);
    for (const row of preview.buttons) {
      for (const b of row) {
        expect(Buffer.byteLength(b.callbackData, "utf8")).toBeLessThanOrEqual(64);
      }
    }

    const stats = await prisma.importBatch.findUniqueOrThrow({
      where: { id: preview.batchId },
      select: { stats: true },
    });
    const fp = (stats.stats as unknown as { fingerprint: string }).fingerprint;

    const res = await confirmChatImport(preview.batchId, fp.slice(0, 8));
    expect(res.ok).toBe(true);
    expect(await prisma.transaction.count()).toBe(6);
  });

  it("чужой отпечаток не подтверждает импорт", async () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const preview = await startChatImport({ fileName: "ещё.csv", bytes });
    const res = await confirmChatImport(preview.batchId, "deadbeef");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/устарел/i);
  });

  it("отмена ничего не записывает", async () => {
    const before = await prisma.transaction.count();
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const preview = await startChatImport({ fileName: "отмена.csv", bytes });
    await cancelChatImport(preview.batchId);
    const res = await confirmChatImport(preview.batchId, "00000000");
    expect(res.ok).toBe(false);
    expect(await prisma.transaction.count()).toBe(before);
  });
});
