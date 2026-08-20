/**
 * Курсор незавершённой работы — в памяти процесса.
 *
 * Зачем. Кроны лидогена опрашивают базу каждые 15 и 30 минут, и почти всегда
 * впустую: прогонов нет, кандидатов нет. На Neon это не бесплатно — 144
 * пробуждения компьюта в сутки при нулевой работе, больше, чем экономила вся
 * оптимизация напоминаний. Ровно тот же случай, что минутный крон напоминаний,
 * и решение то же: помнить в памяти, есть ли работа, — контейнер один, и все
 * пути постановки работы проходят через этот же процесс.
 *
 * Инвариант тот же, что у курсора напоминаний, только булев: **курсор не
 * имеет права говорить «пусто», когда работа есть.** Ошибка в сторону «есть»
 * стоит одного лишнего запроса; ошибка в сторону «пусто» — работы, которая
 * молча лежит до пересинхронизации.
 *
 * Страховка от забытого пути постановки — та же: раз в шесть часов курсор
 * перечитывается независимо от значения. Сетка идёт от полуночи UTC и потому
 * совпадает с сеткой resync напоминаний и суточным пульсом: страховочные
 * походы в базу случаются в ту же минуту и не оплачиваются отдельным
 * пробуждением. Тест compute-budget.test.ts это закрепляет.
 */

/** Домены работы. Закрытый список: свободная строка расползлась бы опечатками. */
export type WorkDomain = "parse" | "scoring";

const RESYNC_MS = 6 * 60 * 60 * 1000;

interface DomainState {
  /** null — «не знаем» (старт процесса); дальше честный булев. */
  pending: boolean | null;
  /** Когда последний раз ходили в базу — от этого считается страховка. */
  lastPollMs: number;
  /** Счётчик пометок: отличает «пометили во время опроса» от «до него». */
  markSeq: number;
  /** Номер текущего опроса: устаревший ответ не смеет объявлять «пусто». */
  pollSeq: number;
}

const states = new Map<WorkDomain, DomainState>();

function state(domain: WorkDomain): DomainState {
  let s = states.get(domain);
  if (!s) {
    s = { pending: null, lastPollMs: 0, markSeq: 0, pollSeq: 0 };
    states.set(domain, s);
  }
  return s;
}

function grid(ms: number): number {
  return Math.floor(ms / RESYNC_MS);
}

/** Идти ли в базу на этом тике. */
export function shouldPollWork(domain: WorkDomain, now: Date = new Date()): boolean {
  const s = state(domain);
  if (s.pending === null || s.pending) return true;
  return grid(now.getTime()) !== grid(s.lastPollMs);
}

/**
 * Появилась работа. Вызывается из путей постановки — создание прогона,
 * появление кандидата. Дёшево настолько, что звать можно на каждую строку.
 */
export function markPendingWork(domain: WorkDomain): void {
  const s = state(domain);
  s.pending = true;
  s.markSeq += 1;
}

export interface WorkPollToken {
  seq: number;
  markSeqAtBegin: number;
}

/** Начало похода в базу — строго ДО запроса, как у курсора напоминаний. */
export function beginWorkPoll(domain: WorkDomain): WorkPollToken {
  const s = state(domain);
  s.pollSeq += 1;
  return { seq: s.pollSeq, markSeqAtBegin: s.markSeq };
}

/**
 * Поход завершён. «Пусто» принимается только от актуального опроса и только
 * если за время похода никто не пометил новую работу: ответ базы — снимок
 * прошлого, и он не отменяет то, что появилось после снимка.
 */
export function completeWorkPoll(
  domain: WorkDomain,
  token: WorkPollToken,
  stillPending: boolean,
  now: Date = new Date(),
): void {
  const s = state(domain);
  if (stillPending) {
    s.pending = true;
    if (token.seq === s.pollSeq) s.lastPollMs = now.getTime();
    return;
  }
  // Устаревший опрос или гонка с пометкой — «пусто» не засчитывается.
  if (token.seq !== s.pollSeq || s.markSeq !== token.markSeqAtBegin) return;
  s.pending = false;
  s.lastPollMs = now.getTime();
}

/** Только для тестов. */
export function resetPendingWork(): void {
  states.clear();
}
