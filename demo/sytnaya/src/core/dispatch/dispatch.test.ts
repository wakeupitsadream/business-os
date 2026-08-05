import { describe, expect, it } from "vitest";

import { haversineKm, travelMinutes } from "../geo";
import type {
  Brand,
  BrandId,
  Kitchen,
  KitchenId,
  LoadSnapshot,
  PendingOrder,
} from "../types";
import { CALIBRATION } from "./calibration";
import { estimateEta } from "./eta";
import {
  courierWaitMinutes,
  fallbackOrdersInProgress,
  isStale,
  queueMinutes,
} from "./load";
import { chooseKitchen } from "./route";

const NOW = new Date("2026-08-05T12:00:00.000Z");

const kitchen = (over: Partial<Kitchen> & Pick<Kitchen, "id">): Kitchen => ({
  name: over.id,
  address: "",
  coords: { lat: 51.77, lon: 55.1 },
  coordsVerified: false,
  parallelSlots: 4,
  brands: ["sushi"],
  ...over,
});

const snapshot = (
  over: Partial<LoadSnapshot> & Pick<LoadSnapshot, "kitchenId">,
): LoadSnapshot => ({
  ordersInProgress: 0,
  couriersOnShift: 3,
  ordersInDelivery: 0,
  takenAt: NOW,
  ...over,
});

const brand = (id: BrandId, homeKitchenId?: KitchenId): Brand => ({
  id,
  name: id,
  cuisine: "",
  domain: "",
  homeKitchenId,
  verified: false,
  theme: { accent: "#000", accentInk: "#fff", surface: "#fff" },
});

describe("гео", () => {
  it("расстояние между одной и той же точкой — ноль", () => {
    const p = { lat: 51.77, lon: 55.1 };
    expect(haversineKm(p, p)).toBe(0);
  });

  it("километр по широте считается близко к километру", () => {
    // 0.009 градуса широты ≈ 1 км. Проверяем порядок величины, а не знаки
    // после запятой: цель — поймать перепутанные lat/lon и градусы с
    // радианами, а не проверить точность формулы.
    const km = haversineKm({ lat: 51.77, lon: 55.1 }, { lat: 51.779, lon: 55.1 });
    expect(km).toBeGreaterThan(0.9);
    expect(km).toBeLessThan(1.1);
  });

  it("время в пути растёт вместе с расстоянием", () => {
    const from = { lat: 51.77, lon: 55.1 };
    const near = travelMinutes(from, { lat: 51.78, lon: 55.1 });
    const far = travelMinutes(from, { lat: 51.85, lon: 55.1 });
    expect(far).toBeGreaterThan(near);
  });
});

describe("очередь кухни", () => {
  it("свободная кухня берёт заказ сразу", () => {
    expect(queueMinutes(kitchen({ id: "k", parallelSlots: 4 }), 0)).toBe(0);
    expect(queueMinutes(kitchen({ id: "k", parallelSlots: 4 }), 3)).toBe(0);
  });

  it("заполненная кухня добавляет волну", () => {
    const k = kitchen({ id: "k", parallelSlots: 4 });
    expect(queueMinutes(k, 4)).toBe(CALIBRATION.cookBaseMin);
    expect(queueMinutes(k, 8)).toBe(CALIBRATION.cookBaseMin * 2);
  });

  it("очередь монотонна по загрузке", () => {
    // Немонотонность здесь означала бы, что рост загрузки может УСКОРИТЬ
    // кухню — диспетчер начал бы отправлять заказы в завал.
    const k = kitchen({ id: "k", parallelSlots: 3 });
    let prev = -1;
    for (let n = 0; n <= 30; n += 1) {
      const value = queueMinutes(k, n);
      expect(value).toBeGreaterThanOrEqual(prev);
      prev = value;
    }
  });

  it("нулевые слоты не делят на ноль", () => {
    expect(Number.isFinite(queueMinutes(kitchen({ id: "k", parallelSlots: 0 }), 5))).toBe(
      true,
    );
  });
});

describe("ожидание курьера", () => {
  it("свободные курьеры не заставляют ждать", () => {
    expect(
      courierWaitMinutes(
        snapshot({ kitchenId: "k", couriersOnShift: 3, ordersInDelivery: 2 }),
      ),
    ).toBe(0);
  });

  it("перегруженные курьеры добавляют круг", () => {
    // 2 курьера × 2 заказа = 4 в обороте; 8 в доставке — это два круга.
    expect(
      courierWaitMinutes(
        snapshot({ kitchenId: "k", couriersOnShift: 2, ordersInDelivery: 8 }),
      ),
    ).toBe(CALIBRATION.courierRoundTripMin * 2);
  });

  it("ноль курьеров не даёт Infinity", () => {
    // Infinity ломает сортировку вариантов и вылезает в интерфейс как «NaN».
    const wait = courierWaitMinutes(
      snapshot({ kitchenId: "k", couriersOnShift: 0, ordersInDelivery: 3 }),
    );
    expect(Number.isFinite(wait)).toBe(true);
    expect(wait).toBeGreaterThan(0);
  });
});

describe("протухание", () => {
  it("свежий срез не протух", () => {
    expect(isStale(snapshot({ kitchenId: "k", takenAt: NOW }), NOW)).toBe(false);
  });

  it("срез старше порога протух", () => {
    const old = new Date(NOW.getTime() - (CALIBRATION.stalenessMin + 1) * 60_000);
    expect(isStale(snapshot({ kitchenId: "k", takenAt: old }), NOW)).toBe(true);
  });

  it("запасная оценка выше в вечерний пик, чем ночью", () => {
    expect(fallbackOrdersInProgress(19)).toBeGreaterThan(fallbackOrdersInProgress(9));
  });
});

describe("оценка времени", () => {
  const base = {
    kitchen: kitchen({ id: "k", parallelSlots: 4 }),
    destination: { lat: 51.79, lon: 55.12 },
    now: NOW,
    localHour: 17,
  };

  it("готовка и курьер считаются параллельно, а не складываются", () => {
    // Самая дорогая ошибка в таких моделях. Курьер возвращается, пока заказ
    // печётся; сложение даёт завышение на десятки минут в час пик и убивает
    // весь смысл системы.
    const eta = estimateEta({
      ...base,
      snapshot: snapshot({
        kitchenId: "k",
        ordersInProgress: 8,
        couriersOnShift: 1,
        ordersInDelivery: 4,
      }),
    });

    const { queueMin, cookMin, courierWaitMin, travelMin } = eta.breakdown;
    const sumOfAll = queueMin + cookMin + courierWaitMin + travelMin;
    expect(eta.totalMin).toBeLessThan(sumOfAll);

    const parallel =
      Math.max(queueMin + cookMin, courierWaitMin) + travelMin + CALIBRATION.handoffMin;
    expect(eta.totalMin).toBe(Math.round(parallel));
  });

  it("свежий срез даёт основу live", () => {
    const eta = estimateEta({ ...base, snapshot: snapshot({ kitchenId: "k" }) });
    expect(eta.basis).toBe("live");
  });

  it("протухший срез даёт основу estimate и не роняет расчёт", () => {
    const old = new Date(NOW.getTime() - 90 * 60_000);
    const eta = estimateEta({
      ...base,
      snapshot: snapshot({ kitchenId: "k", takenAt: old, couriersOnShift: 0 }),
    });
    expect(eta.basis).toBe("estimate");
    expect(Number.isFinite(eta.totalMin)).toBe(true);
    expect(eta.totalMin).toBeGreaterThan(0);
  });

  it("обещание не опускается ниже нижней границы", () => {
    const eta = estimateEta({
      ...base,
      destination: base.kitchen.coords,
      snapshot: snapshot({ kitchenId: "k", ordersInProgress: 0, ordersInDelivery: 0 }),
    });
    expect(eta.totalMin).toBeGreaterThanOrEqual(CALIBRATION.promiseFloorMin);
  });

  it("интервал никогда не схлопывается в точку", () => {
    // «45–45» читается как обещание к минуте, которого мы не давали.
    for (let orders = 0; orders < 24; orders += 1) {
      const eta = estimateEta({
        ...base,
        snapshot: snapshot({ kitchenId: "k", ordersInProgress: orders }),
      });
      expect(eta.toMin).toBeGreaterThan(eta.fromMin);
    }
  });
});

describe("выбор кухни", () => {
  const brands = new Map<BrandId, Brand>([
    ["sushi", brand("sushi", "busy")],
    ["pizza", brand("pizza")],
  ]);

  const order: PendingOrder = {
    lines: [
      { brandId: "sushi", sku: "s1", title: "Ролл", priceKopecks: 39000, qty: 1 },
    ],
    destination: { lat: 51.775, lon: 55.105 },
  };

  it("заказ уходит на менее загруженную кухню", () => {
    const busy = kitchen({ id: "busy", brands: ["sushi"] });
    const free = kitchen({ id: "free", brands: ["sushi"] });

    const decision = chooseKitchen({
      order,
      kitchens: [busy, free],
      brands,
      snapshots: new Map([
        ["busy", snapshot({ kitchenId: "busy", ordersInProgress: 16 })],
        ["free", snapshot({ kitchenId: "free", ordersInProgress: 0 })],
      ]),
      now: NOW,
      localHour: 17,
    });

    expect(decision.chosen?.kitchen.id).toBe("free");
  });

  it("кухня, которая не готовит бренд, отсеивается с причиной", () => {
    const wrong = kitchen({ id: "wrong", brands: ["pizza"] });
    const right = kitchen({ id: "right", brands: ["sushi"] });

    const decision = chooseKitchen({
      order,
      kitchens: [wrong, right],
      brands,
      snapshots: new Map([
        // Неподходящая кухня намеренно пустая: если бы фильтр по бренду не
        // работал, она выиграла бы по времени и заказ ушёл бы туда, где его
        // физически не могут приготовить.
        ["wrong", snapshot({ kitchenId: "wrong", ordersInProgress: 0 })],
        ["right", snapshot({ kitchenId: "right", ordersInProgress: 12 })],
      ]),
      now: NOW,
      localHour: 17,
    });

    expect(decision.chosen?.kitchen.id).toBe("right");
    const rejected = decision.considered.find((o) => o.kitchen.id === "wrong");
    expect(rejected?.canCookAll).toBe(false);
    expect(rejected?.rejectedReason).toContain("не готовит");
  });

  it("кухня без данных о загрузке не выбирается", () => {
    const blind = kitchen({ id: "blind", brands: ["sushi"] });
    const known = kitchen({ id: "known", brands: ["sushi"] });

    const decision = chooseKitchen({
      order,
      kitchens: [blind, known],
      brands,
      snapshots: new Map([
        ["known", snapshot({ kitchenId: "known", ordersInProgress: 12 })],
      ]),
      now: NOW,
      localHour: 17,
    });

    expect(decision.chosen?.kitchen.id).toBe("known");
    expect(
      decision.considered.find((o) => o.kitchen.id === "blind")?.rejectedReason,
    ).toBe("нет данных о загрузке");
  });

  it("выигрыш считается против родной кухни бренда", () => {
    const busy = kitchen({ id: "busy", brands: ["sushi"] });
    const free = kitchen({ id: "free", brands: ["sushi"] });

    const decision = chooseKitchen({
      order,
      kitchens: [busy, free],
      brands,
      snapshots: new Map([
        ["busy", snapshot({ kitchenId: "busy", ordersInProgress: 20 })],
        ["free", snapshot({ kitchenId: "free", ordersInProgress: 0 })],
      ]),
      now: NOW,
      localHour: 17,
    });

    expect(decision.chosen?.kitchen.id).toBe("free");
    expect(decision.savedVsNaiveMin).toBeGreaterThan(0);
  });

  it("если родная кухня и так лучшая, выигрыш нулевой, а не отрицательный", () => {
    // Система обязана уметь говорить «здесь я не нужна». Отрицательный
    // выигрыш в отчёте владельцу выглядит как ошибка расчёта.
    const home = kitchen({ id: "busy", brands: ["sushi"] });
    const other = kitchen({ id: "free", brands: ["sushi"] });

    const decision = chooseKitchen({
      order,
      kitchens: [home, other],
      brands,
      snapshots: new Map([
        ["busy", snapshot({ kitchenId: "busy", ordersInProgress: 0 })],
        ["free", snapshot({ kitchenId: "free", ordersInProgress: 20 })],
      ]),
      now: NOW,
      localHour: 17,
    });

    expect(decision.chosen?.kitchen.id).toBe("busy");
    expect(decision.savedVsNaiveMin).toBe(0);
  });

  it("без единой подходящей кухни решение пустое, а не случайное", () => {
    const decision = chooseKitchen({
      order,
      kitchens: [kitchen({ id: "pizza-only", brands: ["pizza"] })],
      brands,
      snapshots: new Map([
        ["pizza-only", snapshot({ kitchenId: "pizza-only" })],
      ]),
      now: NOW,
      localHour: 17,
    });

    expect(decision.chosen).toBeNull();
    expect(decision.savedVsNaiveMin).toBeNull();
  });

  it("заказ из позиций двух брендов уходит на кухню, готовящую оба", () => {
    const both = kitchen({ id: "both", brands: ["sushi", "pizza"] });
    const onlySushi = kitchen({ id: "sushi-only", brands: ["sushi"] });

    const mixed: PendingOrder = {
      lines: [
        { brandId: "sushi", sku: "s1", title: "Ролл", priceKopecks: 39000, qty: 1 },
        { brandId: "pizza", sku: "p1", title: "Пицца", priceKopecks: 63000, qty: 1 },
      ],
      destination: order.destination,
    };

    const decision = chooseKitchen({
      order: mixed,
      kitchens: [onlySushi, both],
      brands,
      snapshots: new Map([
        ["sushi-only", snapshot({ kitchenId: "sushi-only", ordersInProgress: 0 })],
        ["both", snapshot({ kitchenId: "both", ordersInProgress: 12 })],
      ]),
      now: NOW,
      localHour: 17,
    });

    expect(decision.chosen?.kitchen.id).toBe("both");
  });
});
