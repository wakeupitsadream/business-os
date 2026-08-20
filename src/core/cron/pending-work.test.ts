import { beforeEach, describe, expect, it } from "vitest";
import {
  beginWorkPoll,
  completeWorkPoll,
  markPendingWork,
  resetPendingWork,
  shouldPollWork,
} from "./pending-work";

/**
 * Курсор незавершённой работы.
 *
 * Инвариант один, и все тесты про него: курсор не имеет права говорить
 * «пусто», когда работа есть. Ошибка «есть» стоит лишнего запроса, ошибка
 * «пусто» — прогона, который молча лежит до шестичасовой сверки.
 */

const T = (iso: string) => new Date(iso);
const NOW = T("2026-08-10T10:00:00Z");

beforeEach(() => {
  resetPendingWork();
});

describe("жизненный цикл", () => {
  it("на старте процесса — «не знаю», идём в базу", () => {
    expect(shouldPollWork("parse", NOW)).toBe(true);
  });

  it("после пустого опроса спим до границы сетки", () => {
    completeWorkPoll("parse", beginWorkPoll("parse"), false, NOW);
    expect(shouldPollWork("parse", T("2026-08-10T11:59:00Z"))).toBe(false);
    // 12:00 UTC — граница шестичасовой сетки от полуночи.
    expect(shouldPollWork("parse", T("2026-08-10T12:00:00Z"))).toBe(true);
  });

  it("пометка будит немедленно", () => {
    completeWorkPoll("parse", beginWorkPoll("parse"), false, NOW);
    markPendingWork("parse");
    expect(shouldPollWork("parse", T("2026-08-10T10:01:00Z"))).toBe(true);
  });

  it("«ещё есть работа» оставляет курсор бодрым", () => {
    completeWorkPoll("parse", beginWorkPoll("parse"), true, NOW);
    expect(shouldPollWork("parse", T("2026-08-10T10:01:00Z"))).toBe(true);
  });

  it("домены независимы", () => {
    completeWorkPoll("parse", beginWorkPoll("parse"), false, NOW);
    expect(shouldPollWork("scoring", NOW)).toBe(true);
  });
});

describe("гонки — ошибаться можно только в сторону «есть»", () => {
  it("пометка во время опроса переживает ответ «пусто»", () => {
    // Крон читает базу, владелец в этот момент ставит прогон. Ответ базы —
    // снимок прошлого, он не отменяет то, что появилось после снимка.
    const token = beginWorkPoll("parse");
    markPendingWork("parse");
    completeWorkPoll("parse", token, false, NOW);
    expect(shouldPollWork("parse", T("2026-08-10T10:01:00Z"))).toBe(true);
  });

  it("устаревший опрос не смеет объявлять «пусто»", () => {
    const stale = beginWorkPoll("parse");
    beginWorkPoll("parse"); // начался более свежий
    completeWorkPoll("parse", stale, false, NOW);
    expect(shouldPollWork("parse", T("2026-08-10T10:01:00Z"))).toBe(true);
  });

  it("«есть работа» принимается и от устаревшего опроса", () => {
    const stale = beginWorkPoll("parse");
    const fresh = beginWorkPoll("parse");
    completeWorkPoll("parse", fresh, false, NOW);
    completeWorkPoll("parse", stale, true, NOW);
    expect(shouldPollWork("parse", T("2026-08-10T10:01:00Z"))).toBe(true);
  });
});
