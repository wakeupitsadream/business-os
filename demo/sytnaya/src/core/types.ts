/**
 * Домен «Сытной доставки»: несколько брендов на общих кухнях.
 *
 * Ключевая особенность бизнеса — брендов больше, чем кухонь. Один и тот же цех
 * готовит для нескольких вывесок, поэтому «загрузка» — свойство КУХНИ, а не
 * сайта. Из этого следует всё остальное: заказ с сайта бренда не привязан
 * жёстко к одной кухне, его можно отдать любой, которая умеет готовить эти
 * позиции, и выбор между ними — то, ради чего вся система и существует.
 */

/** Точка на карте. Широта/долгота в градусах. */
export type Coords = {
  readonly lat: number;
  readonly lon: number;
};

/** Идентификатор кухни (физического цеха). */
export type KitchenId = string;

/** Идентификатор бренда (вывески, у которой свой сайт и свой домен). */
export type BrandId = string;

/**
 * Физическая кухня.
 *
 * `parallelSlots` — сколько заказов цех реально ведёт одновременно, а не
 * сколько поваров стоит на смене. Это разные числа: на раздаче узкое место
 * обычно один-два человека, и именно оно определяет, как быстро рассасывается
 * очередь.
 */
export type Kitchen = {
  readonly id: KitchenId;
  readonly name: string;
  readonly address: string;
  readonly coords: Coords;
  /** Сколько заказов кухня готовит параллельно, не растягивая время. */
  readonly parallelSlots: number;
  /** Бренды, которые эта кухня умеет готовить. */
  readonly brands: readonly BrandId[];
  /**
   * Координаты подтверждены геокодером, а не проставлены на глаз.
   *
   * Пока false — расстояния и время в пути ориентировочные. Движок работает и
   * так, но обещать клиенту минуты на таких координатах нельзя.
   */
  readonly coordsVerified: boolean;
};

/**
 * Бренд — вывеска со своим сайтом. К кухне отношения не имеет: связь
 * «кто готовит» живёт в `Kitchen.brands`, потому что она many-to-many.
 */
export type Brand = {
  readonly id: BrandId;
  readonly name: string;
  readonly cuisine: string;
  /** Домен витрины. Пустая строка — домен ещё не выбран. */
  readonly domain: string;
  /** Фирменные цвета витрины. */
  readonly theme: BrandTheme;
  /**
   * Кухня, за которой бренд закреплён «по умолчанию».
   *
   * Это то, как заказы распределяются СЕЙЧАС, без системы: заказ с сайта
   * бренда едет на свою кухню, даже если она забита, а соседняя простаивает.
   * Диспетчер использует это поле не для выбора, а как точку отсчёта —
   * чтобы показать владельцу, сколько минут даёт переключение.
   */
  readonly homeKitchenId?: KitchenId;
  /**
   * Данные бренда сверены с источниками владельца.
   *
   * Пока false — витрину показывать владельцу нельзя: названия, цены и адреса
   * не подтверждены. Смысл флага в том, чтобы непроверенное не утекло в демо
   * молча (ровно на этом обжёгся эталон: справочники дают неверные адреса).
   */
  readonly verified: boolean;
};

export type BrandTheme = {
  readonly accent: string;
  readonly accentInk: string;
  readonly surface: string;
};

/**
 * Живой срез загрузки кухни. Два числа, которые нельзя вычислить, — их
 * сообщает внешний источник (админка, бот курьеров или iiko).
 *
 * Всё остальное — время готовки, ожидание курьера, дорога — считается из них.
 */
export type LoadSnapshot = {
  readonly kitchenId: KitchenId;
  /** Заказов в работе на кухне (готовятся либо ждут выдачи). */
  readonly ordersInProgress: number;
  /** Курьеров на смене, привязанных к этой кухне. */
  readonly couriersOnShift: number;
  /** Заказов, уже отданных курьерам и едущих к клиенту. */
  readonly ordersInDelivery: number;
  /** Когда срез снят. По нему определяется протухание. */
  readonly takenAt: Date;
};

/**
 * На чём основана оценка времени.
 *
 * `live` — на свежих счётчиках, `estimate` — на кривой по времени суток,
 * когда счётчики протухли. Разница попадает в интерфейс: во втором случае
 * клиенту показывается «ориентировочно», а не точный интервал.
 */
export type EtaBasis = "live" | "estimate";

/** Разложенная по слагаемым оценка времени доставки. */
export type EtaBreakdown = {
  /** Ожидание в очереди кухни, минуты. */
  readonly queueMin: number;
  /** Собственно готовка, минуты. */
  readonly cookMin: number;
  /** Ожидание свободного курьера, минуты. */
  readonly courierWaitMin: number;
  /** Дорога до клиента, минуты. */
  readonly travelMin: number;
};

/** Итоговое обещание клиенту. */
export type Eta = {
  /** Ожидаемое время, минуты. */
  readonly totalMin: number;
  /** Нижняя граница обещанного интервала, минуты. */
  readonly fromMin: number;
  /** Верхняя граница обещанного интервала, минуты. */
  readonly toMin: number;
  readonly basis: EtaBasis;
  readonly breakdown: EtaBreakdown;
};

/** Позиция заказа. Цена — целые копейки. */
export type OrderLine = {
  readonly brandId: BrandId;
  readonly sku: string;
  readonly title: string;
  readonly priceKopecks: number;
  readonly qty: number;
};

/** Заказ на момент выбора кухни: адрес известен, кухня — ещё нет. */
export type PendingOrder = {
  readonly lines: readonly OrderLine[];
  readonly destination: Coords;
};

/** Решение диспетчера по одной кухне. */
export type KitchenOption = {
  readonly kitchen: Kitchen;
  readonly eta: Eta;
  /** Кухня умеет готовить весь заказ целиком. */
  readonly canCookAll: boolean;
  /** Почему кухня не подходит. Пусто, если подходит. */
  readonly rejectedReason?: string;
};

/** Результат маршрутизации: куда отдать заказ и почему. */
export type DispatchDecision = {
  readonly chosen: KitchenOption | null;
  /** Все рассмотренные варианты, по возрастанию времени. Для объяснимости. */
  readonly considered: readonly KitchenOption[];
  /**
   * Насколько выбор лучше «родной» кухни бренда, минуты.
   *
   * Это и есть та величина, которую владелец видит как эффект системы:
   * сколько минут сэкономлено по сравнению с наивной привязкой.
   */
  readonly savedVsNaiveMin: number | null;
};
