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

/**
 * Районы — второй множитель выдачи.
 *
 * Не для красоты: с восемью компаниями заглушка помещается в одну страницу
 * (у Geosearch она до 50), то есть курсор всегда пуст, а резюмируемость —
 * главное, ради чего заглушка и написана, — не проверяется ни разу. Восемь на
 * семнадцать даёт три страницы: столько же, сколько исполнитель берёт за тик.
 */
const DISTRICTS = [
  "Центр",
  "Уралмаш",
  "Юго-Запад",
  "Эльмаш",
  "Ботаника",
  "Пионерский",
  "Сортировка",
  "Химмаш",
  "Академический",
  "Втузгородок",
  "Заречный",
  "Компрессорный",
  "Широкая речка",
  "Синие камни",
  "Уктус",
  "Шарташ",
  "Вторчермет",
];

const TOTAL = NAMES.length * DISTRICTS.length;

/**
 * Телефон по номеру записи: одиннадцать цифр, начиная с 7, и заведомо
 * уникальный. Именно на них проверяется дедуп по номеру, ради которого
 * `Lead.phoneNormalized` сделан уникальным, — «телефон», который не проходит
 * нормализацию, проверял бы не то.
 */
function stubPhone(index: number): string {
  const national = `9${String(index).padStart(9, "0")}`;
  return `+7 ${national.slice(0, 3)} ${national.slice(3, 6)}-${national.slice(6, 8)}-${national.slice(8)}`;
}

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

    const take = Math.max(0, Math.min(pageSize, TOTAL - skip));
    const companies: ParsedCompany[] = Array.from({ length: take }, (_, i) => {
      const index = skip + i;
      const name = NAMES[index % NAMES.length];
      const district = DISTRICTS[Math.floor(index / NAMES.length) % DISTRICTS.length];
      return {
        externalId: `stub-${query.city}-${query.rubric}-${index}`,
        source: "stub",
        name: `[demo] ${name} (${district})`,
        niche: "AUTO_SERVICE",
        city: query.city,
        address: `${query.city}, ${district}, улица Демонстрационная, ${index + 1}`,
        phones: [stubPhone(index)],
        site: index % 3 === 0 ? null : `https://demo-${index}.example`,
        rating: index % 2 === 0 ? 4.2 : null,
        reviewsCount: index % 2 === 0 ? 17 + index : null,
        isPersonalData: false,
        raw: { stub: true, index },
      };
    });

    const nextIndex = skip + take;
    return {
      companies,
      nextCursor: nextIndex >= TOTAL ? null : { skip: nextIndex },
      requestsUsed: 1,
    };
  },
};
