import { envFlag } from "@/core/env";
import { assertCanRequest } from "./throttle";
import type {
  ConnectorLimits,
  LeadConnector,
  ParsedCompany,
  SearchQuery,
  SearchResult,
} from "./types";

/**
 * Заглушка источника: выдумывает правдоподобные компании, никуда не ходит.
 *
 * Нужна ровно потому, что ключа Geosearch пока нет, а весь путь вокруг
 * коннектора — троттлинг, курсор, резюмируемость, дедуп при импорте в CRM —
 * написан и должен быть проверяем СЕЙЧАС. Иначе к моменту появления ключа
 * выяснится, что путь никто ни разу не проходил целиком.
 *
 * Идёт через тот же `assertCanRequest`, что и настоящий коннектор. Это не для
 * красоты: если заглушка обходит троттлинг, то она проверяет не ту систему,
 * которая поедет в прод, и первое же отличие всплывёт на боевой квоте.
 *
 * Включается флагом `SALES_STUB_CONNECTOR=1` и по умолчанию выключена: молча
 * подсунуть выдуманные компании в воронку владельца — худшее, что может
 * сделать заглушка. Названия начинаются с «[demo]», чтобы даже попав в CRM
 * они не притворялись настоящими.
 */

const DEFAULT_LIMITS: ConnectorLimits = { requestsPerMinute: 60, dailyCap: 500 };

/** Фрагменты названий: узнаваемо для ниши, но заведомо ненастоящие. */
const NAMES = [
  "АвтоЛидер",
  "Гараж 24",
  "Мотор Плюс",
  "Колесо",
  "СТО на Заречной",
  "Шинный двор",
  "АвтоДок",
  "Механика",
];

export const stubConnector: LeadConnector = {
  id: "stub",
  label: "Заглушка (демо-данные)",
  limits: DEFAULT_LIMITS,

  isConfigured(): boolean {
    return envFlag("SALES_STUB_CONNECTOR");
  },

  async search(query: SearchQuery): Promise<SearchResult> {
    // Тот же путь троттлинга, что и у настоящего источника.
    await assertCanRequest(stubConnector.id, stubConnector.limits);

    const pageSize = Math.min(query.pageSize ?? 10, 50);
    const skip = typeof query.cursor?.skip === "number" ? query.cursor.skip : 0;
    const total = NAMES.length;

    const slice = NAMES.slice(skip, skip + pageSize);
    const companies: ParsedCompany[] = slice.map((name, i) => {
      const index = skip + i;
      return {
        externalId: `stub-${query.city}-${query.rubric}-${index}`,
        source: "stub",
        name: `[demo] ${name}`,
        niche: "AUTO_SERVICE",
        city: query.city,
        address: `${query.city}, улица Демонстрационная, ${index + 1}`,
        // Телефоны детерминированы и различны: на них проверяется дедуп по
        // номеру, ради которого `Lead.phoneNormalized` и сделан уникальным.
        phones: [`+7 999 ${String(100 + index).padStart(3, "0")}-00-${String(10 + index)}`],
        site: index % 3 === 0 ? null : `https://demo-${index}.example`,
        rating: index % 2 === 0 ? 4.2 : null,
        reviewsCount: index % 2 === 0 ? 17 + index : null,
        isPersonalData: false,
        raw: { stub: true, index },
      };
    });

    const nextIndex = skip + slice.length;
    return {
      companies,
      nextCursor: nextIndex >= total ? null : { skip: nextIndex },
      requestsUsed: 1,
    };
  },
};
