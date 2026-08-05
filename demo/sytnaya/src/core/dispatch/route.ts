import type {
  Brand,
  BrandId,
  DispatchDecision,
  Kitchen,
  KitchenId,
  KitchenOption,
  LoadSnapshot,
  PendingOrder,
} from "../types";
import { estimateEta } from "./eta";

/**
 * Выбор кухни под заказ — ядро всей системы.
 *
 * Сегодня заказ едет на «свою» кухню бренда независимо от того, что там
 * творится. Когда семь вывесок делят три цеха, это регулярно означает: одна
 * кухня стоит в завале, соседняя простаивает, а клиент обеих ждёт одинаково
 * долго. Здесь заказ отдаётся той кухне, которая реально привезёт быстрее.
 *
 * Важно, что решение объяснимо: наружу отдаются ВСЕ рассмотренные варианты с
 * разложенным временем. Владелец должен видеть, почему заказ ушёл на Кичигина,
 * а не на Театральную — иначе система выглядит как чёрный ящик, и первый же
 * спорный случай её похоронит.
 */
export function chooseKitchen(args: {
  order: PendingOrder;
  kitchens: readonly Kitchen[];
  brands: ReadonlyMap<BrandId, Brand>;
  snapshots: ReadonlyMap<KitchenId, LoadSnapshot>;
  now: Date;
  localHour: number;
}): DispatchDecision {
  const { order, kitchens, brands, snapshots, now, localHour } = args;

  const neededBrands = new Set(order.lines.map((line) => line.brandId));

  const considered: KitchenOption[] = kitchens.map((kitchen) => {
    const canCook = new Set(kitchen.brands);
    const missing = [...neededBrands].filter((id) => !canCook.has(id));

    const snapshot = snapshots.get(kitchen.id);

    if (!snapshot) {
      // Кухня без среза не рассматривается: без двух чисел мы про неё не знаем
      // ничего, а угадывать — значит отправить заказ вслепую.
      return {
        kitchen,
        eta: emptyEta(),
        canCookAll: missing.length === 0,
        rejectedReason: "нет данных о загрузке",
      };
    }

    const eta = estimateEta({
      kitchen,
      snapshot,
      destination: order.destination,
      now,
      localHour,
    });

    if (missing.length > 0) {
      const names = missing.map((id) => brands.get(id)?.name ?? id).join(", ");
      return {
        kitchen,
        eta,
        canCookAll: false,
        rejectedReason: `не готовит: ${names}`,
      };
    }

    return { kitchen, eta, canCookAll: true };
  });

  const eligible = considered
    .filter((option) => option.canCookAll && option.rejectedReason === undefined)
    .sort((a, b) => a.eta.totalMin - b.eta.totalMin);

  const chosen = eligible[0] ?? null;

  return {
    chosen,
    // Сортируем весь список для показа: сначала подходящие по времени, потом
    // отсеянные. Порядок — часть объяснения, а не косметика.
    considered: [...considered].sort((a, b) => {
      const aOk = a.canCookAll && a.rejectedReason === undefined;
      const bOk = b.canCookAll && b.rejectedReason === undefined;
      if (aOk !== bOk) return aOk ? -1 : 1;
      return a.eta.totalMin - b.eta.totalMin;
    }),
    savedVsNaiveMin: savedVsNaive({ order, brands, considered, chosen }),
  };
}

/**
 * Сколько минут выиграно против нынешнего порядка вещей.
 *
 * Точка отсчёта — «родная» кухня первого бренда в заказе: именно туда заказ
 * ушёл бы сегодня. Если родная кухня совпала с выбранной, выигрыш нулевой —
 * и это честный результат, а не повод что-то подкрутить: система обязана
 * говорить «здесь я не нужна» ровно так же уверенно, как и обратное.
 */
function savedVsNaive(args: {
  order: PendingOrder;
  brands: ReadonlyMap<BrandId, Brand>;
  considered: readonly KitchenOption[];
  chosen: KitchenOption | null;
}): number | null {
  const { order, brands, considered, chosen } = args;
  if (!chosen) return null;

  const firstLine = order.lines[0];
  if (!firstLine) return null;

  const homeId = brands.get(firstLine.brandId)?.homeKitchenId;
  if (homeId === undefined) return null;

  const home = considered.find((option) => option.kitchen.id === homeId);
  // Родная кухня не в списке или сама по себе не может собрать заказ —
  // сравнивать не с чем, и выдумывать базу нельзя.
  if (!home || home.rejectedReason !== undefined) return null;

  return Math.max(0, home.eta.totalMin - chosen.eta.totalMin);
}

/** Заглушка времени для кухни, по которой нет данных. */
function emptyEta(): KitchenOption["eta"] {
  return {
    totalMin: Number.MAX_SAFE_INTEGER,
    fromMin: 0,
    toMin: 0,
    basis: "estimate",
    breakdown: { queueMin: 0, cookMin: 0, courierWaitMin: 0, travelMin: 0 },
  };
}
