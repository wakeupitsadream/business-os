/**
 * Русские названия перечислений воронки.
 *
 * Один файл на все экраны продаж: «MESSAGE_WA», написанное в двух местах
 * по-разному, — мелочь, которая делает интерфейс похожим на отладочный вывод.
 */

export const LOST_REASONS = [
  { value: "PRICE", label: "Дорого" },
  { value: "NO_NEED", label: "Не нужно" },
  { value: "COMPETITOR", label: "Ушли к конкуренту" },
  { value: "NO_ANSWER", label: "Не отвечают" },
  { value: "BAD_TIMING", label: "Не сейчас" },
  { value: "OTHER", label: "Другое" },
] as const;

export const LOST_REASON_LABEL: Record<string, string> = Object.fromEntries(
  LOST_REASONS.map((r) => [r.value, r.label]),
);

/** Виды касаний, которые владелец заводит руками. STAGE_CHANGE пишет только код. */
export const TOUCH_KINDS = [
  { value: "CALL", label: "Звонок" },
  { value: "MESSAGE_TG", label: "Telegram" },
  { value: "MESSAGE_WA", label: "WhatsApp" },
  { value: "EMAIL", label: "Почта" },
  { value: "MEETING", label: "Встреча" },
  { value: "NOTE", label: "Заметка" },
] as const;

export type ManualTouchKind = (typeof TOUCH_KINDS)[number]["value"];

export const TOUCH_KIND_LABEL: Record<string, string> = {
  ...Object.fromEntries(TOUCH_KINDS.map((k) => [k.value, k.label])),
  STAGE_CHANGE: "Стадия",
};

export const NICHE_LABEL: Record<string, string> = {
  AUTO_SERVICE: "Автосервис",
  PRIVATE_MASTER: "Частный мастер",
  OTHER: "Другое",
};

export const SOURCE_LABEL: Record<string, string> = {
  INBOUND_SITE: "Заявка с сайта",
  YANDEX_GEO: "Яндекс",
  TWO_GIS: "2ГИС",
  MANUAL: "Вручную",
  REFERRAL: "Рекомендация",
};
