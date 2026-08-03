import { beforeEach, describe, expect, it } from "vitest";
import {
  beginCursorSync,
  noteReminderDue,
  invalidateReminderCursor,
  reminderCursorState,
  resetReminderCursor,
  setEarliestReminder,
  shouldCheckReminders,
} from "./reminder-cursor";

/**
 * Курсор ближайшего напоминания.
 *
 * Он существует ради экономии пробуждений базы, но цена ошибки
 * несимметрична: лишний запрос стоит долей копейки, а пропущенное
 * напоминание — это невыполненное обещание системы, ради которого её и
 * заводили. Поэтому все тесты здесь проверяют одно: курсор НИКОГДА не бывает
 * позже настоящего ближайшего срабатывания.
 */

const T = (iso: string) => new Date(iso);
const NOW = T("2026-07-30T12:00:00Z");

beforeEach(() => {
  resetReminderCursor();
});

describe("пока состояние базы неизвестно", () => {
  it("на старте процесса идём в базу", () => {
    // Курсор пуст — единственный честный ответ «не знаю, надо спросить».
    expect(shouldCheckReminders(NOW)).toBe(true);
    expect(reminderCursorState().knows).toBe(false);
  });

  it("подсказка о новом сроке не мешает первому запросу", () => {
    noteReminderDue(T("2026-08-01T12:00:00Z"));
    expect(shouldCheckReminders(NOW)).toBe(true);
  });
});

describe("когда база ответила", () => {
  it("до срока в базу не ходим", () => {
    setEarliestReminder(T("2026-07-30T18:00:00Z"), NOW);
    expect(shouldCheckReminders(NOW)).toBe(false);
  });

  it("в момент срока идём", () => {
    setEarliestReminder(T("2026-07-30T12:00:00Z"), NOW);
    expect(shouldCheckReminders(NOW)).toBe(true);
  });

  it("после срока идём", () => {
    setEarliestReminder(T("2026-07-30T11:59:00Z"), NOW);
    expect(shouldCheckReminders(NOW)).toBe(true);
  });

  it("активных напоминаний нет — не ходим вовсе", () => {
    setEarliestReminder(null, NOW);
    expect(shouldCheckReminders(NOW)).toBe(false);
    expect(reminderCursorState().knows).toBe(true);
    expect(reminderCursorState().earliest).toBeNull();
  });
});

describe("новое напоминание двигает курсор раньше", () => {
  it("напоминание раньше известного — курсор сдвигается", () => {
    setEarliestReminder(T("2026-07-30T18:00:00Z"), NOW);
    expect(shouldCheckReminders(T("2026-07-30T12:05:00Z"))).toBe(false);

    noteReminderDue(T("2026-07-30T12:03:00Z"));
    expect(shouldCheckReminders(T("2026-07-30T12:05:00Z"))).toBe(true);
  });

  it("напоминание позже известного курсор НЕ отодвигает", () => {
    // Иначе более раннее напоминание было бы проспано.
    setEarliestReminder(T("2026-07-30T13:00:00Z"), NOW);
    noteReminderDue(T("2026-07-30T20:00:00Z"));

    expect(reminderCursorState().earliest?.toISOString()).toBe("2026-07-30T13:00:00.000Z");
    expect(shouldCheckReminders(T("2026-07-30T13:00:00Z"))).toBe(true);
  });

  it("первое напоминание при пустом списке будит курсор", () => {
    setEarliestReminder(null, NOW);
    expect(shouldCheckReminders(T("2026-07-30T12:10:00Z"))).toBe(false);

    noteReminderDue(T("2026-07-30T12:09:00Z"));
    expect(shouldCheckReminders(T("2026-07-30T12:10:00Z"))).toBe(true);
  });

  it("напоминание в прошлом срабатывает немедленно", () => {
    setEarliestReminder(T("2026-08-01T00:00:00Z"), NOW);
    noteReminderDue(T("2026-07-30T11:00:00Z"));
    expect(shouldCheckReminders(NOW)).toBe(true);
  });
});

describe("запись во время похода в базу не теряется", () => {
  /**
   * Гонка на ровном месте: контейнер один, крон и обработчик сообщения
   * Telegram — задачи одного процесса и переключаются на каждом `await`. Пока
   * крон ждёт ответ `findFirst`, владелец успевает сказать «напомни через
   * минуту». Ответ базы — снимок ДО этой записи, и присвоить его как есть
   * значит стереть новое напоминание.
   */

  it("напоминание, созданное во время запроса, переживает ответ базы", () => {
    setEarliestReminder(T("2026-07-30T13:00:00Z"), NOW);

    beginCursorSync(); // крон пошёл в базу
    noteReminderDue(T("2026-07-30T12:01:00Z")); // владелец создал напоминание
    setEarliestReminder(T("2026-07-30T13:00:00Z"), NOW); // база ответила снимком «до»

    expect(reminderCursorState().earliest?.toISOString()).toBe("2026-07-30T12:01:00.000Z");
    expect(shouldCheckReminders(T("2026-07-30T12:01:00Z"))).toBe(true);
  });

  it("то же самое, когда база отвечает «активных нет»", () => {
    // Самый опасный вариант: пустой ответ ставит курсор в Infinity, и без
    // защиты напоминание проспало бы до ежечасной сверки.
    beginCursorSync();
    noteReminderDue(T("2026-07-30T12:02:00Z"));
    setEarliestReminder(null, NOW);

    expect(reminderCursorState().earliest?.toISOString()).toBe("2026-07-30T12:02:00.000Z");
    expect(shouldCheckReminders(T("2026-07-30T12:02:00Z"))).toBe(true);
  });

  it("гонка на самом первом синке тоже покрыта", () => {
    // Курсор ещё «не знает» состояния базы, поэтому noteReminderDue не может
    // подвинуть его напрямую — значение обязано дожить в накопителе.
    expect(reminderCursorState().knows).toBe(false);

    beginCursorSync();
    noteReminderDue(T("2026-07-30T12:03:00Z"));
    setEarliestReminder(null, NOW);

    expect(reminderCursorState().earliest?.toISOString()).toBe("2026-07-30T12:03:00.000Z");
  });

  it("прогон, начатый раньше, не отменяет работу более свежего", () => {
    // Сценарий из разбора. 12:00 — прогон A пошёл в базу и застрял на медленном
    // Telegram. 12:01 — стартовал прогон B (курсор ещё в прошлом, поэтому тик
    // состоялся). 12:01:30 владелец создал напоминание на 12:30. База отвечает
    // обоим снимком «до» — ближайшее 18:00.
    setEarliestReminder(T("2026-07-30T11:00:00Z"), NOW); // курсор в прошлом
    const tokenA = beginCursorSync();
    const tokenB = beginCursorSync();

    noteReminderDue(T("2026-07-30T12:30:00Z"));

    // B — текущий, его ответ применяется вместе с накопленным.
    setEarliestReminder(T("2026-07-30T18:00:00Z"), NOW, tokenB);
    expect(reminderCursorState().earliest?.toISOString()).toBe("2026-07-30T12:30:00.000Z");

    // A приходит позже со СВОИМ, ещё более старым снимком — и не должен
    // отодвинуть курсор на 18:00, иначе напоминание проспит до часовой сверки.
    setEarliestReminder(T("2026-07-30T18:00:00Z"), NOW, tokenA);
    expect(reminderCursorState().earliest?.toISOString()).toBe("2026-07-30T12:30:00.000Z");
    expect(shouldCheckReminders(T("2026-07-30T12:30:00Z"))).toBe(true);
  });

  it("устаревший ответ всё же может подвинуть курсор РАНЬШЕ", () => {
    // Ошибаться можно только в раннюю сторону: лишний запрос дешевле.
    setEarliestReminder(T("2026-07-30T18:00:00Z"), NOW);
    const stale = beginCursorSync();
    beginCursorSync(); // начался следующий поход

    setEarliestReminder(T("2026-07-30T13:00:00Z"), NOW, stale);
    expect(reminderCursorState().earliest?.toISOString()).toBe("2026-07-30T13:00:00.000Z");
  });

  it("устаревший ответ не выводит курсор из «не знаю»", () => {
    // «Не знаю» — самое осторожное состояние: следующий тик и так сходит в базу.
    const stale = beginCursorSync();
    beginCursorSync();

    setEarliestReminder(T("2026-12-31T00:00:00Z"), NOW, stale);
    expect(reminderCursorState().knows).toBe(false);
    expect(shouldCheckReminders(NOW)).toBe(true);
  });

  it("устаревший ответ не сбрасывает часовой отсчёт свежего", () => {
    setEarliestReminder(T("2026-12-31T00:00:00Z"), NOW);
    const stale = beginCursorSync();
    beginCursorSync();

    setEarliestReminder(T("2026-12-31T00:00:00Z"), T("2026-07-30T12:59:00Z"), stale);
    // Отсчёт часа ведётся от NOW, а не от времени устаревшего ответа.
    expect(shouldCheckReminders(T("2026-07-30T13:00:00Z"))).toBe(true);
  });

  it("накопитель не держит старое: следующий синк начинается с чистого листа", () => {
    beginCursorSync();
    noteReminderDue(T("2026-07-30T12:04:00Z"));
    setEarliestReminder(null, NOW);

    // Напоминание сработало и исчезло — второй синк не обязан его помнить.
    beginCursorSync();
    setEarliestReminder(null, T("2026-07-30T12:05:00Z"));

    expect(reminderCursorState().earliest).toBeNull();
    expect(shouldCheckReminders(T("2026-07-30T12:06:00Z"))).toBe(false);
  });
});

describe("самолечение раз в час", () => {
  it("через час курсор перечитывается, даже если срок далеко", () => {
    // Страховка на случай, если новый путь записи забудут подключить к
    // курсору: цена забывчивости — час задержки, а не потерянное напоминание.
    setEarliestReminder(T("2026-12-31T00:00:00Z"), NOW);

    expect(shouldCheckReminders(T("2026-07-30T12:59:00Z"))).toBe(false);
    expect(shouldCheckReminders(T("2026-07-30T13:00:00Z"))).toBe(true);
  });

  it("после перечитывания отсчёт часа начинается заново", () => {
    setEarliestReminder(T("2026-12-31T00:00:00Z"), NOW);
    setEarliestReminder(T("2026-12-31T00:00:00Z"), T("2026-07-30T13:00:00Z"));

    expect(shouldCheckReminders(T("2026-07-30T13:30:00Z"))).toBe(false);
    expect(shouldCheckReminders(T("2026-07-30T14:00:00Z"))).toBe(true);
  });

  it("пустой список тоже перечитывается раз в час", () => {
    setEarliestReminder(null, NOW);
    expect(shouldCheckReminders(T("2026-07-30T13:00:00Z"))).toBe(true);
  });
});

describe("явный сброс", () => {
  it("возвращает курсор в «не знаю»", () => {
    setEarliestReminder(T("2026-12-31T00:00:00Z"), NOW);
    expect(shouldCheckReminders(NOW)).toBe(false);

    invalidateReminderCursor();
    expect(shouldCheckReminders(NOW)).toBe(true);
  });
});

describe("экономия, ради которой всё затевалось", () => {
  it("сутки без напоминаний — ни одного похода в базу сверх ежечасных", () => {
    let checks = 0;
    setEarliestReminder(null, NOW);

    // Минутные тики за сутки.
    for (let minute = 1; minute <= 24 * 60; minute += 1) {
      const tick = new Date(NOW.getTime() + minute * 60_000);
      if (shouldCheckReminders(tick)) {
        checks += 1;
        setEarliestReminder(null, tick);
      }
    }

    // 1440 тиков превращаются в 24 запроса вместо 1440.
    expect(checks).toBe(24);
  });

  it("напоминание внутри суток срабатывает вовремя, а не по расписанию сверки", () => {
    setEarliestReminder(null, NOW);
    const due = new Date(NOW.getTime() + 7 * 60_000);
    noteReminderDue(due);

    let firedAt: Date | null = null;
    for (let minute = 1; minute <= 60; minute += 1) {
      const tick = new Date(NOW.getTime() + minute * 60_000);
      if (shouldCheckReminders(tick)) {
        firedAt = tick;
        break;
      }
    }

    expect(firedAt?.toISOString()).toBe(new Date(NOW.getTime() + 7 * 60_000).toISOString());
  });
});
