import { stubConnector } from "./stub";
import { yandexGeoConnector } from "./yandex-geo";
import type { ConnectorId, LeadConnector } from "./types";

/**
 * Реестр источников лидогена.
 *
 * Порядок — приоритет: сначала настоящий источник, заглушка последней. Она и
 * не должна выбираться, пока есть хоть один рабочий: выдуманные компании в
 * воронке владельца хуже пустой воронки.
 */
const ALL: LeadConnector[] = [yandexGeoConnector, stubConnector];

export function allConnectors(): LeadConnector[] {
  return [...ALL];
}

/** Только те, у которых есть ключ (или явно включённая заглушка). */
export function configuredConnectors(): LeadConnector[] {
  return ALL.filter((c) => c.isConfigured());
}

export function connectorById(id: ConnectorId): LeadConnector | null {
  return ALL.find((c) => c.id === id) ?? null;
}

/**
 * Чем искать прямо сейчас. `null` — не настроен ни один источник; это
 * нормальное состояние до появления ключа, и звать его ошибкой не нужно.
 */
export function defaultConnector(): LeadConnector | null {
  return configuredConnectors()[0] ?? null;
}

export { stubConnector } from "./stub";
export { yandexGeoConnector } from "./yandex-geo";
export {
  assertCanRequest,
  reserveRequest,
  resetMinuteWindow,
  usedToday,
  utcDayKey,
} from "./throttle";
export {
  ConnectorError,
  type ConnectorCursor,
  type ConnectorId,
  type ConnectorLimits,
  type LeadConnector,
  type ParsedCompany,
  type SearchQuery,
  type SearchResult,
} from "./types";
