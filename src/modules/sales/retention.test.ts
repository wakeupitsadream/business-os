import { beforeEach, describe, expect, it, vi } from "vitest";
import { TZDate } from "@date-fns/tz";
import { OWNER_TZ } from "@/core/shared/time";

/**
 * Удержание: сигнал «платёж не пришёл».
 *
 * Ложная тревога здесь дороже пропущенной — владелец, которого система дёргает
 * зря, перестаёт ей верить, и тогда не сработает и настоящий сигнал. Поэтому
 * большая часть тестов ниже проверяет, что система МОЛЧИТ.
 */

const configured = vi.fn(() => true);
const scheduleFollowUpMock = vi.fn(async (..._a: unknown[]) => ({ id: "f1" }));

const accountFindUnique = vi.fn(async (..._a: unknown[]) => null as unknown);
const customerFindMany = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const customerUpdate = vi.fn(async (..._a: unknown[]) => ({}));
const customerUpdateMany = vi.fn(async (..._a: unknown[]) => ({ count: 1 }));
const txFindMany = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const eventCreate = vi.fn(async (..._a: unknown[]) => ({ id: "e1" }));

vi.mock("@/modules/finance/yookassa/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/finance/yookassa/client")>();
  return { ...actual, yooConfigured: () => configured() };
});

vi.mock("./leads", () => ({
  scheduleFollowUp: (...a: unknown[]) => scheduleFollowUpMock(...a),
}));

vi.mock("@/core/db", () => ({
  prisma: {
    account: { findUnique: (...a: unknown[]) => accountFindUnique(...a) },
    customer: {
      findMany: (...a: unknown[]) => customerFindMany(...a),
      update: (...a: unknown[]) => customerUpdate(...a),
      updateMany: (...a: unknown[]) => customerUpdateMany(...a),
    },
    transaction: { findMany: (...a: unknown[]) => txFindMany(...a) },
    domainEvent: { create: (...a: unknown[]) => eventCreate(...a) },
  },
}));

const { checkRetention, expectedNextPaymentAt } = await import("./retention");

const NOW = new Date("2026-08-20T09:00:00Z");

function customer(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    leadId: "l1",
    dealId: "d1",
    subscriptionId: "sub_1",
    missedSignalKey: null,
    ...over,
  };
}

/** Платежи 10-го числа: июнь и июль. Следующий ждём 10 августа. */
function twoPayments() {
  return [
    { date: new Date("2026-06-10T08:00:00Z"), amountKop: 500_000 },
    { date: new Date("2026-07-10T08:00:00Z"), amountKop: 500_000 },
  ];
}

beforeEach(() => {
  configured.mockReset().mockReturnValue(true);
  scheduleFollowUpMock.mockReset().mockResolvedValue({ id: "f1" });
  accountFindUnique.mockReset().mockResolvedValue({ lastSyncedAt: new Date("2026-08-20T06:00:00Z") });
  customerFindMany.mockReset().mockResolvedValue([]);
  customerUpdate.mockReset().mockResolvedValue({});
  customerUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  txFindMany.mockReset().mockResolvedValue([]);
  eventCreate.mockReset().mockResolvedValue({ id: "e1" });
});

describe("ожидаемая дата платежа", () => {
  it("якорь — день месяца, а не «плюс тридцать дней»", () => {
    // 31 января + 30 дней = 2 марта, потом 1 апреля: за год окно уезжает на
    // неделю и тревога начинает срабатывать на ровном месте.
    const jan31 = new Date("2026-01-31T08:00:00Z");
    const next = expectedNextPaymentAt(31, jan31);
    const local = new TZDate(next, OWNER_TZ);
    expect(local.getMonth()).toBe(1); // февраль
  });

  it("31-е число зажимается по длине месяца, а не переносится на следующий", () => {
    const jan31 = new Date("2026-01-31T08:00:00Z");
    const local = new TZDate(expectedNextPaymentAt(31, jan31), OWNER_TZ);
    expect(local.getDate()).toBe(28); // февраль 2026 — не високосный
  });

  it("обычный день месяца сохраняется", () => {
    const local = new TZDate(
      expectedNextPaymentAt(10, new Date("2026-07-10T08:00:00Z")),
      OWNER_TZ,
    );
    expect(local.getDate()).toBe(10);
    expect(local.getMonth()).toBe(7); // август
  });
});

describe("система молчит, когда должна молчать", () => {
  it("устаревший синк отменяет проверку целиком", async () => {
    // Протухший ключ или суточный простой дают ноль платежей у ВСЕХ клиентов
    // разом. Без этой проверки система завела бы задачу на каждого.
    accountFindUnique.mockResolvedValue({ lastSyncedAt: new Date("2026-08-18T06:00:00Z") });
    customerFindMany.mockResolvedValue([customer()]);

    const res = await checkRetention(NOW);

    expect(res.skippedStaleSync).toBe(true);
    expect(res.alarms).toBe(0);
    expect(scheduleFollowUpMock).not.toHaveBeenCalled();
  });

  it("ненастроенный синк тоже отменяет проверку", async () => {
    configured.mockReturnValue(false);
    customerFindMany.mockResolvedValue([customer()]);

    const res = await checkRetention(NOW);

    expect(res.skippedStaleSync).toBe(true);
    expect(scheduleFollowUpMock).not.toHaveBeenCalled();
  });

  it("клиент с одним платежом тревоги не поднимает", async () => {
    // Неизвестно, месячная у него подписка, годовая или конвертированный триал.
    customerFindMany.mockResolvedValue([customer()]);
    txFindMany.mockResolvedValue([{ date: new Date("2026-06-10T08:00:00Z"), amountKop: 500_000 }]);

    const res = await checkRetention(NOW);

    expect(res.alarms).toBe(0);
    expect(scheduleFollowUpMock).not.toHaveBeenCalled();
  });

  it("платёж, опоздавший на четыре дня, тревогу не вызывает", async () => {
    // Джоба — сверщик: платёж просто двигает ожидание на следующий месяц.
    customerFindMany.mockResolvedValue([customer()]);
    txFindMany.mockResolvedValue([
      ...twoPayments(),
      { date: new Date("2026-08-14T08:00:00Z"), amountKop: 500_000 },
    ]);

    const res = await checkRetention(NOW);

    expect(res.alarms).toBe(0);
    expect(scheduleFollowUpMock).not.toHaveBeenCalled();
  });

  it("внутри отсрочки молчим", async () => {
    // Ждали 10 августа, сегодня 13-е: ЮKassa ещё сама ретраит списание.
    customerFindMany.mockResolvedValue([customer()]);
    txFindMany.mockResolvedValue(twoPayments());

    const res = await checkRetention(new Date("2026-08-13T09:00:00Z"));

    expect(res.alarms).toBe(0);
  });

  it("тревога по этому циклу уже поднята — второй раз не поднимаем", async () => {
    customerFindMany.mockResolvedValue([customer({ missedSignalKey: "2026-08" })]);
    txFindMany.mockResolvedValue(twoPayments());

    const res = await checkRetention(NOW);

    expect(res.alarms).toBe(0);
    expect(scheduleFollowUpMock).not.toHaveBeenCalled();
  });

  it("три молчащих клиента разом — это сбой интеграции, а не три ухода", async () => {
    customerFindMany.mockResolvedValue([
      customer({ id: "c1", leadId: "l1", subscriptionId: "s1" }),
      customer({ id: "c2", leadId: "l2", subscriptionId: "s2" }),
      customer({ id: "c3", leadId: "l3", subscriptionId: "s3" }),
    ]);
    txFindMany.mockResolvedValue(twoPayments());

    const res = await checkRetention(NOW);

    expect(res.massAlarm).toBe(true);
    expect(res.alarms).toBe(0);
    // Ни одной персональной задачи — одно общее событие.
    expect(scheduleFollowUpMock).not.toHaveBeenCalled();
    const event = eventCreate.mock.calls[0]?.[0] as { data: { type: string } };
    expect(event.data.type).toBe("retention.mass_alarm");
  });
});

describe("настоящий пропуск", () => {
  it("поднимает тревогу и заводит задачу «связаться»", async () => {
    customerFindMany.mockResolvedValue([customer()]);
    txFindMany.mockResolvedValue(twoPayments());

    const res = await checkRetention(NOW);

    expect(res.alarms).toBe(1);
    expect(scheduleFollowUpMock).toHaveBeenCalledTimes(1);

    const followUp = scheduleFollowUpMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(followUp.leadId).toBe("l1");
    expect(followUp.origin).toBe("AUTO_RULE");
    expect(String(followUp.note)).toContain("не пришёл");
  });

  it("захват цикла происходит ДО создания задачи", async () => {
    // В обратном порядке падение между шагами заводило бы новую задачу каждый
    // прогон крона.
    customerFindMany.mockResolvedValue([customer()]);
    txFindMany.mockResolvedValue(twoPayments());

    await checkRetention(NOW);

    const claimIndex = customerUpdateMany.mock.invocationCallOrder[0] ?? 0;
    const followUpIndex = scheduleFollowUpMock.mock.invocationCallOrder[0] ?? 0;
    expect(claimIndex).toBeLessThan(followUpIndex);
  });

  it("захват не удался — задача не создаётся", async () => {
    customerFindMany.mockResolvedValue([customer()]);
    txFindMany.mockResolvedValue(twoPayments());
    customerUpdateMany.mockResolvedValue({ count: 0 });

    const res = await checkRetention(NOW);

    expect(res.alarms).toBe(0);
    expect(scheduleFollowUpMock).not.toHaveBeenCalled();
  });

  it("клиент уходит в AT_RISK, а ключ цикла запоминается", async () => {
    customerFindMany.mockResolvedValue([customer()]);
    txFindMany.mockResolvedValue(twoPayments());

    await checkRetention(NOW);

    const data = (customerUpdateMany.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.status).toBe("AT_RISK");
    expect(data.missedSignalKey).toBe("2026-08");
  });
});

describe("пересчёт фактов", () => {
  it("считает только доходы, а не комиссии", async () => {
    customerFindMany.mockResolvedValue([customer()]);
    txFindMany.mockResolvedValue(twoPayments());

    await checkRetention(NOW);

    // Синк пишет на один платёж две строки: доход и комиссию эквайринга.
    const where = (txFindMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
    expect(where.type).toBe("INCOME");
    expect(where.source).toBe("YOOKASSA");
  });

  it("цифры на карточке обновляются даже без тревоги", async () => {
    customerFindMany.mockResolvedValue([customer()]);
    txFindMany.mockResolvedValue([{ date: new Date("2026-08-10T08:00:00Z"), amountKop: 700_000 }]);

    await checkRetention(NOW);

    const data = (customerUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.mrrKop).toBe(700_000);
    expect(data.paymentsCount).toBe(1);
  });
});
