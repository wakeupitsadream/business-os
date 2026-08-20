import { beforeEach, describe, expect, it, vi } from "vitest";
import { dayKey } from "@/core/shared/time";

/**
 * Ночная резервная копия.
 *
 * Проверяется контракт честности: копия либо доставлена, либо крон вернул
 * ok:false и роут поднимет тревогу. Молчаливое «не получилось» здесь —
 * худший исход: копия, которой молча нет, обнаруживается в самый плохой день.
 */

const create = vi.fn(async (..._a: unknown[]) => ({}));
vi.mock("@/core/db", () => ({
  prisma: { domainEvent: { create: (...a: unknown[]) => create(...a) } },
}));

const dump = vi.fn(async (..._a: unknown[]) => ({
  gz: new Uint8Array([31, 139, 8, 0]),
  rawBytes: 100_000,
  gzBytes: 4,
}));
vi.mock("@/core/backup/dump", () => ({
  dumpDatabase: (...a: unknown[]) => dump(...a),
}));

const sendDoc = vi.fn(async (..._a: unknown[]) => true);
vi.mock("@/core/telegram/bot", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/core/telegram/bot")>();
  return {
    ...real,
    tgSendDocumentToOwner: (...a: unknown[]) => sendDoc(...a),
    tgNotifyOwner: vi.fn(async () => true),
  };
});

const { backupDb } = await import("./jobs");

beforeEach(() => {
  vi.unstubAllEnvs();
  create.mockReset();
  dump.mockReset();
  sendDoc.mockReset();
  create.mockResolvedValue({});
  dump.mockResolvedValue({ gz: new Uint8Array([31, 139, 8, 0]), rawBytes: 100_000, gzBytes: 4 });
  sendDoc.mockResolvedValue(true);
  vi.stubEnv("DIRECT_URL", "postgresql://u:p@localhost:5432/bosdev");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "t");
});

describe("успешная ночь", () => {
  it("файл назван по дню владельца и уходит с подсказкой о восстановлении", async () => {
    const res = await backupDb();

    expect(res.ok).toBe(true);
    const [name, bytes, caption] = sendDoc.mock.calls[0] as [string, Uint8Array, string];
    expect(name).toBe(`business-os-${dayKey(new Date())}.sql.gz`);
    expect(bytes.byteLength).toBeGreaterThan(0);
    // Подсказка в подписи — не украшение: восстанавливаться будут в плохой
    // день, и искать документацию в этот момент некогда.
    expect(caption).toContain("OWNER-CHECKLIST");
  });

  it("успех отмечается в ленте событий", async () => {
    await backupDb();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("упавшая запись в ленту не превращает доставленную копию в тревогу", async () => {
    create.mockRejectedValue(new Error("база моргнула"));
    const res = await backupDb();
    expect(res.ok).toBe(true);
  });
});

describe("отказы не глотаются", () => {
  it("без DIRECT_URL — ok:false и дамп не запускается", async () => {
    vi.stubEnv("DIRECT_URL", "");
    const res = await backupDb();
    expect(res.ok).toBe(false);
    expect(dump).not.toHaveBeenCalled();
  });

  it("без Telegram — ok:false: копия, которую некуда деть, не «успех»", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const res = await backupDb();
    expect(res.ok).toBe(false);
    expect(dump).not.toHaveBeenCalled();
  });

  it("не отправилось — ok:false, роут поднимет тревогу", async () => {
    sendDoc.mockResolvedValue(false);
    const res = await backupDb();
    expect(res.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("упавший pg_dump долетает до роута исключением", async () => {
    dump.mockRejectedValue(new Error("server version mismatch"));
    await expect(backupDb()).rejects.toThrow("mismatch");
  });
});

describe("выключатель", () => {
  it("BACKUP_DELIVERY=off — тихо и честно: ok:true с причиной", async () => {
    vi.stubEnv("BACKUP_DELIVERY", "off");
    const res = await backupDb();
    expect(res.ok).toBe(true);
    expect(res.detail).toContain("выключено");
    expect(dump).not.toHaveBeenCalled();
  });
});
