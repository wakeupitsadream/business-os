import { describe, expect, it } from "vitest";
import { computeScore, parseVerdicts, HOT_SCORE, type CandidateSignals } from "./scoring";
import { isForbiddenHost, normalizeSiteUrl, toPlainText } from "./site-probe";

/**
 * Скоринг кандидатов.
 *
 * Проверяются три вещи, и все три — про доверие к числу. Формула должна быть
 * воспроизводимой (иначе на «почему 72» нет ответа), модель не должна иметь
 * возможности подсунуть компанию, которой ей не давали, и запрос на сайт
 * кандидата не должен превращаться в поход по внутренней сети.
 */

function signals(over: Partial<CandidateSignals> = {}): CandidateSignals {
  return {
    hasSite: true,
    siteReachable: true,
    siteQuality: "ok",
    hasOnlineBooking: true,
    socialActivity: false,
    reviewsCount: 0,
    rating: null,
    ...over,
  };
}

describe("формула балла", () => {
  it("складывается из названных слагаемых и не превышает ста", () => {
    const best = computeScore(
      signals({
        hasOnlineBooking: false,
        siteQuality: "poor",
        socialActivity: true,
        reviewsCount: 120,
        rating: 4.8,
      }),
    );

    expect(best.score).toBe(100);
    // Разложение — не украшение: по нему восстанавливается «почему столько».
    expect(best.breakdown.reduce((s, p) => s + p.points, 0)).toBe(best.score);
    expect(best.breakdown.map((p) => p.label)).toContain("нет онлайн-записи");
  });

  it("поток отзывов без онлайн-записи делает кандидата горячим", () => {
    // Портрет клиента Agentus: людей достаточно, записывает руками.
    const hot = computeScore(signals({ hasOnlineBooking: false, reviewsCount: 60, rating: 4.5 }));
    expect(hot.score).toBeGreaterThanOrEqual(HOT_SCORE);
  });

  it("сервис с готовой онлайн-записью горячим не считается", () => {
    // Ему нечего продавать: он уже сделал то, что мы предлагаем. По сумме
    // слагаемых он набирал достаточно — правило вынесено отдельным потолком.
    const cold = computeScore(signals({ hasOnlineBooking: true, reviewsCount: 60, rating: 4.9 }));
    expect(cold.score).toBeLessThan(HOT_SCORE);
    expect(cold.breakdown.map((p) => p.label)).toContain("онлайн-запись уже есть");
    // Потолок виден в разложении: сумма по-прежнему равна баллу.
    expect(cold.breakdown.reduce((s, p) => s + p.points, 0)).toBe(cold.score);
  });

  it("потолок не трогает тех, кто и так ниже порога", () => {
    const weak = computeScore(signals({ hasOnlineBooking: true, reviewsCount: 0 }));
    expect(weak.breakdown.map((p) => p.label)).not.toContain("онлайн-запись уже есть");
  });

  it("недоступный сайт не считается сильным", () => {
    const down = computeScore(signals({ siteReachable: false, siteQuality: "none" }));
    const strong = computeScore(signals({ siteQuality: "good" }));
    expect(down.score).toBeGreaterThan(strong.score);
  });

  it("балл не уходит за границы диапазона", () => {
    const worst = computeScore(signals({ siteQuality: "good", hasOnlineBooking: true }));
    expect(worst.score).toBeGreaterThanOrEqual(0);
    expect(worst.score).toBeLessThanOrEqual(100);
  });
});

describe("разбор ответа модели", () => {
  const known = new Set(["a", "b"]);

  it("берёт только те компании, которые отправляли", () => {
    // Модель, получившая шесть компаний, охотно возвращает седьмую —
    // правдоподобную и выдуманную.
    const out = parseVerdicts(
      JSON.stringify({
        items: [
          { id: "a", siteQuality: "poor", hasOnlineBooking: false, fitReason: "поток есть" },
          { id: "выдумка", siteQuality: "good", hasOnlineBooking: true },
        ],
      }),
      known,
    );

    expect([...out.keys()]).toEqual(["a"]);
  });

  it("неизвестное качество сайта трактуется осторожно", () => {
    const out = parseVerdicts(
      JSON.stringify({ items: [{ id: "a", siteQuality: "великолепно" }] }),
      known,
    );
    expect(out.get("a")?.siteQuality).toBe("poor");
  });

  it("булевы поля признаются только явным true", () => {
    // «да», 1 и "true" — не true. Иначе кандидат с онлайн-записью, о которой
    // модель ответила словом, получил бы лишние 28 баллов.
    const out = parseVerdicts(
      JSON.stringify({ items: [{ id: "a", hasOnlineBooking: "да", socialActivity: 1 }] }),
      known,
    );
    expect(out.get("a")?.hasOnlineBooking).toBe(false);
    expect(out.get("a")?.socialActivity).toBe(false);
  });

  it("мусор вместо JSON даёт пустой результат, а не исключение", () => {
    expect(parseVerdicts("извините, не могу", known).size).toBe(0);
    expect(parseVerdicts("", known).size).toBe(0);
    expect(parseVerdicts('{"items": "нет"}', known).size).toBe(0);
  });

  it("текст вокруг JSON не мешает", () => {
    const out = parseVerdicts(
      'Вот результат:\n{"items": [{"id": "b", "siteQuality": "ok"}]}\nГотово.',
      known,
    );
    expect(out.get("b")?.siteQuality).toBe("ok");
  });
});

describe("запрос на сайт кандидата", () => {
  it.each([
    ["петля", "localhost"],
    ["петля по адресу", "127.0.0.1"],
    ["метаданные хостинга", "169.254.169.254"],
    ["частная сеть", "192.168.1.1"],
    ["частная сеть 10", "10.0.0.5"],
    ["частная сеть 172", "172.20.0.1"],
    ["CGNAT", "100.100.0.1"],
    ["внутреннее имя", "db"],
    ["mDNS", "printer.local"],
    ["IPv6 петля", "::1"],
  ])("%s запрещена", (_name, host) => {
    // Адрес приходит из чужого справочника: строка в поле сайта не должна
    // уметь отправить наш сервер за метаданными хостинга.
    expect(isForbiddenHost(host)).toBe(true);
    expect(normalizeSiteUrl(`http://${host}/`)).toBeNull();
  });

  it("обычный сайт проходит и достраивает схему", () => {
    expect(normalizeSiteUrl("example.ru")?.toString()).toBe("https://example.ru/");
    expect(normalizeSiteUrl("http://avto-serv.ru/uslugi")?.hostname).toBe("avto-serv.ru");
  });

  it("схемы кроме http и https не пускаются", () => {
    expect(normalizeSiteUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeSiteUrl("gopher://example.ru")).toBeNull();
    // data: без хоста — URL разберётся, но протокол не тот.
    expect(normalizeSiteUrl("data:text/html,<h1>hi")).toBeNull();
  });

  it("пустое поле сайта — не ошибка", () => {
    expect(normalizeSiteUrl(null)).toBeNull();
    expect(normalizeSiteUrl("   ")).toBeNull();
  });

  it("разметка выбрасывается вместе со скриптами", () => {
    const text = toPlainText(
      '<html><head><style>.a{color:red}</style><script>alert("запись")</script></head>' +
        "<body><h1>Автосервис</h1><p>Запись&nbsp;по телефону</p></body></html>",
    );
    expect(text).toBe("Автосервис Запись по телефону");
    expect(text).not.toMatch(/alert|color:red/);
  });
});
