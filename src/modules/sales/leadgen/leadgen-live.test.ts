import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/core/db";
import { assertDisposableDatabase } from "@/core/testing/live-db";
import { resetMinuteWindow, utcDayKey } from "../connectors";
import { createLead } from "../leads";
import { createParseJob, readStats } from "./jobs";
import { importCandidate, skipCandidate } from "./import";
import { runParseTick } from "./runner";

/**
 * Лидоген на настоящей базе.
 *
 * Здесь проверяется ровно то, что моками проверить нельзя: что джоба
 * забирается атомарно, что курсор переживает «перезапуск» и работа не
 * начинается заново, что уникальный индекс действительно ловит повтор, и что
 * нечёткий дедуп через pg_trgm возвращает то, что должен, — `similarity()`
 * живёт в PostgreSQL, а не в нашем коде.
 */

const live = process.env.LIVE_DB === "1";
const NOW = new Date("2026-08-02T12:00:00Z");

async function wipe() {
  assertDisposableDatabase();
  await prisma.parsedCompany.deleteMany({});
  await prisma.parseJob.deleteMany({});
  await prisma.touchPoint.deleteMany({});
  await prisma.followUp.deleteMany({});
  await prisma.deal.deleteMany({});
  await prisma.contact.deleteMany({});
  await prisma.lead.deleteMany({});
  await prisma.connectorQuota.deleteMany({});
  resetMinuteWindow();
}

describe.runIf(live)("прогон лидогена", () => {
  beforeEach(async () => {
    await wipe();
    process.env.SALES_STUB_CONNECTOR = "1";
  });

  afterEach(() => {
    delete process.env.SALES_STUB_CONNECTOR;
  });

  it("пустая очередь не трогает ни один внешний API", async () => {
    const res = await runParseTick(NOW);
    expect(res).toMatchObject({ ok: true });
    expect(res.jobId).toBeUndefined();
    // Квота не израсходована: тик при пустой очереди обязан быть бесплатным,
    // иначе крон каждые 15 минут сам съедает суточный кап.
    expect(await prisma.connectorQuota.count()).toBe(0);
  });

  it("прогон доходит до конца и помечается завершённым", async () => {
    const { jobId } = await createParseJob({
      connector: "stub",
      rubric: "автосервис",
      city: "Екатеринбург",
    });

    await runParseTick(NOW);

    const job = await prisma.parseJob.findUniqueOrThrow({ where: { id: jobId } });
    const stats = readStats(job.stats);

    expect(job.status).toBe("DONE");
    expect(job.cursor).toBeNull();
    expect(stats.pages).toBeGreaterThan(1);
    expect(stats.duplicates).toBe(0);
    expect(await prisma.parsedCompany.count()).toBe(stats.stored);
  });

  it("прогон продолжается с сохранённого курсора, а не с начала", async () => {
    // Ровно то, что происходит после каждого деплоя: контейнер перезапустился
    // посреди города. Начать заново значило бы сжечь квоту на уже полученное.
    const { jobId } = await createParseJob({
      connector: "stub",
      rubric: "автосервис",
      city: "Екатеринбург",
    });
    await prisma.parseJob.update({ where: { id: jobId }, data: { cursor: { skip: 100 } } });

    await runParseTick(NOW);

    const job = await prisma.parseJob.findUniqueOrThrow({ where: { id: jobId } });
    const stored = await prisma.parsedCompany.count();

    expect(job.status).toBe("DONE");
    // Первые сто компаний не запрашивались повторно: в базе только хвост.
    expect(stored).toBeGreaterThan(0);
    expect(stored).toBeLessThan(100);
    expect(readStats(job.stats).stored).toBe(stored);
  });

  it("повторный прогон того же запроса не плодит кандидатов", async () => {
    await createParseJob({ connector: "stub", rubric: "автосервис", city: "Екатеринбург" });
    await runParseTick(NOW);
    await runParseTick(new Date(NOW.getTime() + 60_000));
    const first = await prisma.parsedCompany.count();

    await createParseJob({ connector: "stub", rubric: "автосервис", city: "Екатеринбург" });
    await runParseTick(new Date(NOW.getTime() + 120_000));
    await runParseTick(new Date(NOW.getTime() + 180_000));

    expect(await prisma.parsedCompany.count()).toBe(first);
  });

  it("решение владельца переживает повторный прогон", async () => {
    // Иначе каждый ночной прогон возвращал бы в список всё, что владелец уже
    // разобрал, — и список перестали бы открывать на третий день.
    await createParseJob({ connector: "stub", rubric: "автосервис", city: "Екатеринбург" });
    await runParseTick(NOW);

    const candidate = await prisma.parsedCompany.findFirstOrThrow();
    await skipCandidate(candidate.id);

    await createParseJob({ connector: "stub", rubric: "автосервис", city: "Екатеринбург" });
    await runParseTick(new Date(NOW.getTime() + 60_000));

    const after = await prisma.parsedCompany.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(after.status).toBe("SKIPPED");
  });

  it("занятую джобу второй тик не забирает, протухшую — забирает", async () => {
    const { jobId } = await createParseJob({
      connector: "stub",
      rubric: "автосервис",
      city: "Екатеринбург",
    });

    // Контейнер взял джобу минуту назад и ещё работает.
    await prisma.parseJob.update({
      where: { id: jobId },
      data: { status: "RUNNING", lockedAt: new Date(NOW.getTime() - 60_000) },
    });
    expect((await runParseTick(NOW)).jobId).toBeUndefined();

    // Контейнер умер посреди тика: отметка протухла, джобу можно забрать.
    await prisma.parseJob.update({
      where: { id: jobId },
      data: { lockedAt: new Date(NOW.getTime() - 30 * 60_000) },
    });
    expect(await runParseTick(NOW)).toMatchObject({ jobId });
  });

  it("исчерпанный суточный кап откладывает прогон, а не роняет его", async () => {
    const { jobId } = await createParseJob({
      connector: "stub",
      rubric: "автосервис",
      city: "Екатеринбург",
    });

    // Кап выбран целиком — ровно то состояние, в котором бесплатный тир
    // проводит вторую половину суток.
    //
    // День берётся НАСТОЯЩИЙ, а не от фиксированного `NOW`: троттлинг живёт
    // внутри коннектора и смотрит на часы, а не на аргумент тика. С ключом от
    // вчерашнего дня тест зеленел до полуночи UTC и краснел после неё —
    // ровно так он и был пойман.
    await prisma.connectorQuota.create({
      data: { connector: "stub", day: utcDayKey(), used: 10_000 },
    });

    const res = await runParseTick(NOW);
    const job = await prisma.parseJob.findUniqueOrThrow({ where: { id: jobId } });

    expect(res.ok).toBe(true);
    expect(job.status).toBe("PENDING");
    expect(job.error).toBeNull();
    expect(job.lockedAt).toBeNull();
  });

  it("не настроенный источник возвращает прогон в очередь, а не хоронит", async () => {
    const { jobId } = await createParseJob({
      connector: "stub",
      rubric: "автосервис",
      city: "Екатеринбург",
    });
    // Ключ пропал между созданием джобы и тиком: чинится переменной
    // окружения, а не пересозданием прогона.
    delete process.env.SALES_STUB_CONNECTOR;

    await runParseTick(NOW);

    const job = await prisma.parseJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("PENDING");
  });

  it("второй такой же прогон не заводится", async () => {
    // Два одинаковых прогона поделили бы суточный кап пополам и оба не дошли
    // бы до конца.
    await createParseJob({ connector: "stub", rubric: "автосервис", city: "Екатеринбург" });
    await expect(
      createParseJob({ connector: "stub", rubric: "автосервис", city: "Екатеринбург" }),
    ).rejects.toThrow(/уже идёт/);
  });
});

describe.runIf(live)("дедуп при импорте кандидата", () => {
  beforeEach(async () => {
    await wipe();
    process.env.SALES_STUB_CONNECTOR = "1";
  });

  afterEach(() => {
    delete process.env.SALES_STUB_CONNECTOR;
  });

  async function candidate(over: Record<string, unknown> = {}) {
    return prisma.parsedCompany.create({
      data: {
        source: "stub",
        externalId: `ext-${Math.floor(Number(over.seed ?? 1))}`,
        name: "Автосервис на Ленина",
        niche: "AUTO_SERVICE",
        city: "Екатеринбург",
        address: "улица Ленина, 5",
        phones: ["+7 999 123-45-67"],
        phoneNormalized: "79991234567",
        site: "https://example.ru",
        ...over,
        seed: undefined,
      } as never,
    });
  }

  it("второй уровень: тот же телефон склеивается с существующим лидом", async () => {
    const existing = await createLead({ name: "ИП Кузнецов А.А.", phone: "8 (999) 123-45-67" });
    const c = await candidate();

    const res = await importCandidate(c.id);

    expect(res).toMatchObject({ outcome: "merged", leadId: existing.leadId });
    expect(await prisma.lead.count()).toBe(1);
  });

  it("склейка не затирает то, что владелец уже заполнил", async () => {
    const existing = await createLead({
      name: "ИП Кузнецов А.А.",
      phone: "8 (999) 123-45-67",
      city: "Первоуральск",
    });
    await importCandidate((await candidate()).id);

    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: existing.leadId } });
    // Справочник не точнее владельца: у него бывает старый адрес, а владелец
    // мог поправить город руками.
    expect(lead.city).toBe("Первоуральск");
  });

  it("третий уровень: похожее название спрашивает, а не склеивает молча", async () => {
    // «Автосервис на Ленина» и «Автосервис на Ленина, 5» могут быть одним
    // делом, а могут быть двумя точками сети. Автоматика однажды соединит
    // разных клиентов, и разобрать это будет уже нечем.
    const existing = await createLead({
      name: "Автосервис на Ленина, 5",
      phone: "+7 999 777-66-55",
      city: "Екатеринбург",
    });
    const c = await candidate({ phoneNormalized: null, phones: [] });

    const res = await importCandidate(c.id);

    expect(res.outcome).toBe("needs_confirmation");
    expect(res.similar?.[0]?.leadId).toBe(existing.leadId);
    expect(res.similar?.[0]?.similarity).toBeGreaterThan(0.6);
    // Ничего не создано и не помечено: ответ владельца ещё впереди.
    expect(await prisma.lead.count()).toBe(1);
    expect((await prisma.parsedCompany.findUniqueOrThrow({ where: { id: c.id } })).status).toBe(
      "NEW",
    );
  });

  it("третий уровень: «это другая компания» заводит нового лида", async () => {
    await createLead({
      name: "Автосервис на Ленина, 5",
      phone: "+7 999 777-66-55",
      city: "Екатеринбург",
    });
    const c = await candidate({ phoneNormalized: null, phones: [] });

    const res = await importCandidate(c.id, { asNewLead: true });

    expect(res.outcome).toBe("imported");
    expect(await prisma.lead.count()).toBe(2);
  });

  it("третий уровень: «это тот же» подклеивает к указанному лиду", async () => {
    const existing = await createLead({
      name: "Автосервис на Ленина, 5",
      phone: "+7 999 777-66-55",
    });
    const c = await candidate({ phoneNormalized: null, phones: [] });

    const res = await importCandidate(c.id, { mergeIntoLeadId: existing.leadId });

    expect(res).toMatchObject({ outcome: "merged", leadId: existing.leadId });
    expect(await prisma.lead.count()).toBe(1);
    // Пустое у лида дописалось: город у него не был указан.
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: existing.leadId } });
    expect(lead.city).toBe("Екатеринбург");
  });

  it("непохожее название не мешает завести лида", async () => {
    await createLead({ name: "Шинный двор", phone: "+7 999 777-66-55", city: "Екатеринбург" });
    const c = await candidate({ phoneNormalized: null, phones: [] });

    const res = await importCandidate(c.id);

    expect(res.outcome).toBe("imported");
    expect(await prisma.lead.count()).toBe(2);
  });

  it("повторный импорт того же кандидата не заводит второго лида", async () => {
    const c = await candidate();
    const first = await importCandidate(c.id);
    const second = await importCandidate(c.id);

    expect(second).toMatchObject({ outcome: "already", leadId: first.leadId });
    expect(await prisma.lead.count()).toBe(1);
  });

  it("оценка ИИ переезжает на нового лида", async () => {
    const c = await candidate({ score: 72, scoreData: { reasons: ["нет онлайн-записи"] } });

    const res = await importCandidate(c.id);
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: res.leadId! } });

    expect(lead.aiScore).toBe(72);
  });

  it("собранного кандидата можно довести до лида целиком", async () => {
    // Путь целиком: прогон → кандидат → лид. Ради него заглушка и написана.
    await createParseJob({ connector: "stub", rubric: "автосервис", city: "Екатеринбург" });
    await runParseTick(NOW);

    const first = await prisma.parsedCompany.findFirstOrThrow({ orderBy: { externalId: "asc" } });
    const res = await importCandidate(first.id);

    expect(res.outcome).toBe("imported");
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: res.leadId! } });
    expect(lead.source).toBe("MANUAL");
    expect(lead.phoneNormalized).not.toBeNull();
  });
});
