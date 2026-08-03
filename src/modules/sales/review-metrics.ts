import { prisma } from "@/core/db";
import { OWNER_TZ, weekBounds, weekKey } from "@/core/shared/time";

/**
 * Метрики еженедельного разбора. Считает КОД, прямым SQL.
 *
 * Ключевое ограничение, из которого следует всё остальное: `Deal` хранит
 * только ТЕКУЩУЮ стадию. Сделка, прошедшая новый → связались → демо → выиграно,
 * в снимке видна один раз — как выигранная, и конверсии «новый → связались» по
 * нему не существует в принципе. Единственный источник переходов — лента
 * касаний `STAGE_CHANGE`, которую пишет `moveDeal`.
 *
 * Вход в ПЕРВУЮ стадию в ленте не записан: `createDeal` ставит стадию сразу и
 * касания не пишет. Поэтому вход считается по `Deal.createdAt` — иначе у каждой
 * сделки пропадал бы первый интервал, а знаменатель первой конверсии оказался
 * бы занижен ровно на число сделок, ни разу не сдвинутых.
 */

export interface StageConversion {
  fromStageId: string;
  fromStageName: string;
  entered: number;
  advanced: number;
  /** Доля прошедших дальше, 0..1. NULL, когда данных слишком мало. */
  rate: number | null;
}

export interface ReviewMetrics {
  weekKey: string;
  weekStart: string;
  weekEnd: string;
  /** Хватает ли данных, чтобы проценты что-то значили. */
  thin: boolean;
  dealsCreated: number;
  dealsWon: number;
  dealsLost: number;
  leadsCreated: number;
  conversions: StageConversion[];
  lostReasons: Array<{ reason: string; count: number }>;
  stale: Array<{ stageName: string; count: number; maxDays: number }>;
  touches: { promised: number; done: number; skipped: number; overdue: number };
  sources: Array<{ source: string; leads: number; won: number }>;
  wonAmountKop: number;
}

/**
 * Минимум сделок, ниже которого проценты не показываются.
 *
 * «Конверсия 0%» на двух сделках — это не метрика, а шум, и хуже того: она
 * читается как факт и провоцирует решения. Пусть лучше отчёт честно скажет
 * «данных мало».
 */
const MIN_FOR_RATE = 5;

/** Прошлая неделя относительно момента запуска. */
export function lastWeekBounds(now: Date, tz: string = OWNER_TZ): { start: Date; end: Date } {
  // Крон просыпается в понедельник, и weekBounds(now) дал бы ТОЛЬКО ЧТО
  // начавшуюся неделю. Разбирать надо ту, что кончилась.
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  return weekBounds(weekAgo, tz);
}

/**
 * Конверсии по стадиям из ленты переходов.
 *
 * «Вошёл в стадию» — либо переход в неё, либо создание сделки (для первой).
 * «Прошёл дальше» — последующий переход в стадию с большей позицией, не
 * помеченную проигрышем: у проигранной позиция больше, чем у выигранной, и без
 * фильтра проигрыш засчитывался бы как прохождение всей воронки.
 */
async function loadConversions(start: Date, end: Date): Promise<StageConversion[]> {
  const rows = await prisma.$queryRaw<
    Array<{ stage_id: string; stage_name: string; entered: bigint; advanced: bigint }>
  >`
    WITH ledger AS (
      -- Переходы из ленты касаний.
      SELECT
        t."dealId"                        AS deal_id,
        t."meta"->>'toStageId'            AS stage_id,
        t."occurredAt"                    AS at
      FROM "TouchPoint" t
      WHERE t.kind = 'STAGE_CHANGE' AND t."dealId" IS NOT NULL
      UNION ALL
      -- Вход в первую стадию: создание сделки. В ленте его нет.
      --
      -- Брать здесь d."stageId" НЕЛЬЗЯ: это стадия СЕГОДНЯШНЯЯ, а не та, с
      -- которой сделка начиналась. У сделки, дошедшей до демо, вход в «новые»
      -- превратился бы во второй вход в «демо», и первая конверсия пропала бы
      -- целиком. Начальную стадию помнит первый переход — в поле fromStageId.
      SELECT
        d.id,
        COALESCE(
          (
            SELECT t2."meta"->>'fromStageId'
            FROM "TouchPoint" t2
            WHERE t2."dealId" = d.id AND t2.kind = 'STAGE_CHANGE'
            ORDER BY t2."occurredAt" ASC, t2.id ASC
            LIMIT 1
          ),
          d."stageId"
        ),
        d."createdAt"
      FROM "Deal" d
    ),
    positioned AS (
      SELECT l.deal_id, l.stage_id, l.at, s.position, s.name, s."isLost"
      FROM ledger l
      JOIN "PipelineStage" s ON s.id = l.stage_id
    ),
    entries AS (
      SELECT
        p.deal_id,
        p.stage_id,
        p.name,
        p.position,
        p.at,
        -- Была ли впоследствии стадия дальше по воронке (проигрыш не считается).
        --
        -- Сравнение по времени НЕСТРОГОЕ, а отсечка — по позиции. Два перехода
        -- могут лечь в одну миллисекунду: сделку двигают по воронке подряд, а
        -- при переносе истории и вовсе одним временем. Со строгим сравнением такая
        -- пара давала бы «никуда не продвинулся», хотя стадия дальше есть.
        -- Само себя условие не поймает: позиция строго больше.
        EXISTS (
          SELECT 1 FROM positioned q
          WHERE q.deal_id = p.deal_id
            AND q.at >= p.at
            AND q."isLost" = false
            AND q.position > p.position
        ) AS advanced
      FROM positioned p
      WHERE p."isLost" = false
    )
    SELECT
      e.stage_id                              AS stage_id,
      e.name                                  AS stage_name,
      COUNT(*)::bigint                        AS entered,
      COUNT(*) FILTER (WHERE e.advanced)::bigint AS advanced
    FROM entries e
    WHERE e.at >= ${start} AND e.at < ${end}
    GROUP BY e.stage_id, e.name, e.position
    ORDER BY MIN(e.position)
  `;

  return rows.map((r) => {
    const entered = Number(r.entered);
    const advanced = Number(r.advanced);
    return {
      fromStageId: r.stage_id,
      fromStageName: r.stage_name,
      entered,
      advanced,
      rate: entered >= MIN_FOR_RATE ? advanced / entered : null,
    };
  });
}

/**
 * Причины проигрыша за период — из ленты, а не из `Deal.lostReason`.
 *
 * `moveDeal` обнуляет причину, когда сделку возвращают в работу: проигрыш,
 * случившийся на прошлой неделе, исчез бы из статистики задним числом. В ленте
 * он остаётся навсегда.
 */
async function loadLostReasons(start: Date, end: Date) {
  const rows = await prisma.$queryRaw<Array<{ reason: string; count: bigint }>>`
    SELECT t."meta"->>'lostReason' AS reason, COUNT(*)::bigint AS count
    FROM "TouchPoint" t
    WHERE t.kind = 'STAGE_CHANGE'
      AND t."occurredAt" >= ${start} AND t."occurredAt" < ${end}
      AND t."meta"->>'lostReason' IS NOT NULL
    GROUP BY 1
    ORDER BY count DESC
  `;
  return rows.map((r) => ({ reason: r.reason, count: Number(r.count) }));
}

/** Застрявшие: считаются на момент разбора, а не за период. */
async function loadStale(now: Date) {
  const rows = await prisma.$queryRaw<
    Array<{ stage_name: string; count: bigint; max_days: number }>
  >`
    SELECT
      s.name                                                        AS stage_name,
      COUNT(*)::bigint                                              AS count,
      MAX(EXTRACT(EPOCH FROM (${now}::timestamp - d."enteredStageAt")) / 86400)::int AS max_days
    FROM "Deal" d
    JOIN "PipelineStage" s ON s.id = d."stageId"
    WHERE s."isWon" = false AND s."isLost" = false
      AND s."staleAfterDays" IS NOT NULL
      AND d."enteredStageAt" < ${now}::timestamp - (s."staleAfterDays" || ' days')::interval
    GROUP BY s.name, s.position
    ORDER BY s.position
  `;
  return rows.map((r) => ({
    stageName: r.stage_name,
    count: Number(r.count),
    maxDays: Number(r.max_days),
  }));
}

/**
 * Дисциплина касаний: обещали — выполнили.
 *
 * Пропущенные (`SKIPPED`) считаются отдельно и в «выполнено» НЕ попадают:
 * `completeFollowUp` проставляет дату завершения и им тоже, и фильтр по её
 * наличию сделал бы метрику дисциплины тем выше, чем больше обещаний забыто.
 */
async function loadTouchDiscipline(start: Date, end: Date, now: Date) {
  const [promised, done, skipped, overdue] = await Promise.all([
    prisma.followUp.count({ where: { dueAt: { gte: start, lt: end } } }),
    prisma.followUp.count({ where: { dueAt: { gte: start, lt: end }, status: "DONE" } }),
    prisma.followUp.count({ where: { dueAt: { gte: start, lt: end }, status: "SKIPPED" } }),
    prisma.followUp.count({ where: { status: "PENDING", dueAt: { lt: now } } }),
  ]);
  return { promised, done, skipped, overdue };
}

/** Качество источников: сколько лидов и сколько из них дошли до победы. */
async function loadSources(start: Date, end: Date) {
  const rows = await prisma.$queryRaw<Array<{ source: string; leads: bigint; won: bigint }>>`
    SELECT
      l.source::text                          AS source,
      COUNT(DISTINCT l.id)::bigint            AS leads,
      COUNT(DISTINCT d.id) FILTER (WHERE s."isWon")::bigint AS won
    FROM "Lead" l
    LEFT JOIN "Deal" d ON d."leadId" = l.id
    LEFT JOIN "PipelineStage" s ON s.id = d."stageId"
    WHERE l."createdAt" >= ${start} AND l."createdAt" < ${end}
    GROUP BY l.source
    ORDER BY leads DESC
  `;
  return rows.map((r) => ({
    source: r.source,
    leads: Number(r.leads),
    won: Number(r.won),
  }));
}

export async function collectReviewMetrics(now: Date = new Date()): Promise<ReviewMetrics> {
  const { start, end } = lastWeekBounds(now);

  const [conversions, lostReasons, stale, touches, sources, created, won, lost, leads, wonSum] =
    await Promise.all([
      loadConversions(start, end),
      loadLostReasons(start, end),
      loadStale(now),
      loadTouchDiscipline(start, end, now),
      loadSources(start, end),
      prisma.deal.count({ where: { createdAt: { gte: start, lt: end } } }),
      prisma.touchPoint.count({
        where: {
          kind: "STAGE_CHANGE",
          occurredAt: { gte: start, lt: end },
          meta: { path: ["toStageId"], equals: "stage_won" },
        },
      }),
      prisma.touchPoint.count({
        where: {
          kind: "STAGE_CHANGE",
          occurredAt: { gte: start, lt: end },
          meta: { path: ["toStageId"], equals: "stage_lost" },
        },
      }),
      prisma.lead.count({ where: { createdAt: { gte: start, lt: end } } }),
      prisma.deal.aggregate({
        _sum: { amountMonthlyKop: true },
        where: { stage: { isWon: true }, enteredStageAt: { gte: start, lt: end } },
      }),
    ]);

  return {
    weekKey: weekKey(start),
    weekStart: start.toISOString(),
    weekEnd: end.toISOString(),
    // Мало данных — проценты не показываем вовсе, и модель об этом знает.
    thin: created + won + lost < MIN_FOR_RATE,
    dealsCreated: created,
    dealsWon: won,
    dealsLost: lost,
    leadsCreated: leads,
    conversions,
    lostReasons,
    stale,
    touches,
    sources,
    wonAmountKop: wonSum._sum.amountMonthlyKop ?? 0,
  };
}
