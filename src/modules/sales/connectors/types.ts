import type { LeadNiche } from "@prisma/client";

/**
 * Единый интерфейс коннектора лидогена.
 *
 * Коннекторов будет три — Яндекс Geosearch, 2ГИС и ручной импорт с Avito, — и
 * различаются они только тем, откуда берут данные. Всё, что вокруг (троттлинг,
 * резюмируемость, дедуп, скоринг), обязано быть общим: иначе каждый следующий
 * источник принесёт свою копию правил, и суточный кап начнёт соблюдаться в
 * одном месте из трёх.
 *
 * Скрапинга каталогов здесь нет и не будет — только официальные API. Это не
 * осторожность, а условие легальности: пользовательские соглашения Яндекса и
 * 2ГИС запрещают автоматический сбор выдачи, и построенная на нём воронка
 * ставит под удар сам бизнес, ради которого её строят.
 */

/** Компания, как её вернул источник. Ещё не лид: в CRM попадёт после дедупа. */
export interface ParsedCompany {
  /** Идентификатор в системе-источнике. Первый уровень дедупа. */
  externalId: string;
  source: ConnectorId;
  name: string;
  niche: LeadNiche;
  city: string | null;
  address: string | null;
  /** Все найденные телефоны, как их отдал источник. Нормализация — при импорте. */
  phones: string[];
  site: string | null;
  rating: number | null;
  reviewsCount: number | null;
  /**
   * Признак физлица (частный мастер). У таких записей состав данных
   * минимальный и они чистятся по 152-ФЗ, если не сконвертировались.
   */
  isPersonalData: boolean;
  /** Сырой ответ источника — на случай, если разбор однажды окажется неполным. */
  raw: unknown;
}

export interface SearchQuery {
  /** «автосервисы», «шиномонтаж» — то, что человек ввёл бы в поиск. */
  rubric: string;
  city: string;
  /** Сколько компаний просить у источника за один запрос. */
  pageSize?: number;
  /**
   * Курсор предыдущего прогона. Джоба лидогена резюмируема: контейнер
   * перезапускается на каждом деплое, и начинать с нуля значит и время терять,
   * и квоту жечь на уже полученное.
   */
  cursor?: ConnectorCursor | null;
}

/** Непрозрачен для вызывающего: у каждого источника своя пагинация. */
export type ConnectorCursor = Record<string, unknown>;

export interface SearchResult {
  companies: ParsedCompany[];
  /** null — источник отдал всё, что имел. */
  nextCursor: ConnectorCursor | null;
  /** Сколько запросов к API израсходовано этим вызовом. */
  requestsUsed: number;
}

export type ConnectorId = "yandex_geo" | "two_gis" | "stub";

export interface ConnectorLimits {
  /** Потолок частоты, чтобы не получить 429 от источника. */
  requestsPerMinute: number;
  /**
   * Суточный кап. Ставится НИЖЕ реального лимита тарифа: наш день считается по
   * UTC, а провайдер сбрасывает счётчик по своему времени, и запас закрывает
   * расхождение.
   */
  dailyCap: number;
}

export interface LeadConnector {
  readonly id: ConnectorId;
  readonly label: string;
  readonly limits: ConnectorLimits;
  /** Настроен ли: есть ли ключ. Ненастроенный коннектор просто не предлагается. */
  isConfigured(): boolean;
  search(query: SearchQuery): Promise<SearchResult>;
}

export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly kind: "config" | "quota" | "http" | "shape" | "network",
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}
