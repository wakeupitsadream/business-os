import type { LostReason, Prisma } from "@prisma/client";
import { prisma } from "@/core/db";
import { logInfo } from "@/core/observability/logger";

/**
 * Движение сделки по воронке.
 *
 * Единственное место, где меняется `Deal.stageId`. Причина та же, по которой в
 * финансах единственная точка записи операций: правил тут несколько, они
 * неочевидны, и разъехавшись однажды, они дают воронку, которой нельзя верить.
 *
 * Правил три.
 *
 * 1. **Причина проигрыша обязательна.** Без неё «почему не покупают» узнать
 *    неоткуда, а это главный вопрос, ради которого воронку и ведут. Свободный
 *    текст не годится: по нему не построить статистику.
 * 2. **Смена стадии пишет касание.** Иначе история сделки читается как
 *    «ничего не происходило, потом выиграли».
 * 3. **`enteredStageAt` обновляется только при РЕАЛЬНОЙ смене стадии.**
 *    Перетаскивание карточки в ту же колонку — не событие, и обнулять им время
 *    на стадии значит терять «застрявших» ровно тогда, когда владелец их
 *    перебирает.
 */

export class PipelineError extends Error {
  constructor(
    message: string,
    readonly code: "input" | "state" | "not_found" = "input",
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

export interface MoveDealInput {
  dealId: string;
  toStageId: string;
  /** Обязательна при переводе в проигранные. */
  lostReason?: LostReason | null;
  note?: string | null;
}

export interface MoveDealResult {
  dealId: string;
  fromStageId: string;
  toStageId: string;
  /** false, если сделка уже была на этой стадии и ничего не произошло. */
  moved: boolean;
}

export async function moveDeal(input: MoveDealInput): Promise<MoveDealResult> {
  const [deal, toStage] = await Promise.all([
    prisma.deal.findUnique({
      where: { id: input.dealId },
      select: { id: true, leadId: true, stageId: true, title: true, amountMonthlyKop: true },
    }),
    prisma.pipelineStage.findUnique({
      where: { id: input.toStageId },
      select: { id: true, name: true, isLost: true, isWon: true },
    }),
  ]);

  if (!deal) throw new PipelineError("Сделка не найдена.", "not_found");
  if (!toStage) throw new PipelineError("Такой стадии воронки нет.", "not_found");

  if (deal.stageId === toStage.id) {
    // Карточку бросили в ту же колонку. Это не ошибка и не повод трогать
    // enteredStageAt: иначе перебор канбана обнулял бы возраст сделок.
    return { dealId: deal.id, fromStageId: deal.stageId, toStageId: toStage.id, moved: false };
  }

  if (toStage.isLost && !input.lostReason) {
    throw new PipelineError(
      "Для проигранной сделки нужна причина: без неё непонятно, что чинить.",
      "input",
    );
  }

  const fromStage = await prisma.pipelineStage.findUnique({
    where: { id: deal.stageId },
    select: { name: true },
  });

  const now = new Date();
  const meta: Prisma.InputJsonValue = {
    fromStageId: deal.stageId,
    fromStageName: fromStage?.name ?? deal.stageId,
    toStageId: toStage.id,
    toStageName: toStage.name,
    ...(input.lostReason ? { lostReason: input.lostReason } : {}),
  };

  await prisma.$transaction(async (tx) => {
    await tx.deal.update({
      where: { id: deal.id },
      data: {
        stageId: toStage.id,
        enteredStageAt: now,
        // Причина живёт только у проигранных. Уводя сделку обратно в работу,
        // причину надо снять — иначе она всплывёт в статистике потерь как
        // «проиграли по цене», хотя сделка жива.
        lostReason: toStage.isLost ? (input.lostReason ?? null) : null,
      },
    });

    await tx.touchPoint.create({
      data: {
        leadId: deal.leadId,
        dealId: deal.id,
        kind: "STAGE_CHANGE",
        body: input.note?.trim() || null,
        meta,
        occurredAt: now,
      },
    });

    if (toStage.isWon) {
      // Победа заводит клиента. Один клиент на ЛИДА, а не на сделку: вторая
      // выигранная сделка того же лида — это апселл, и второй строкой она
      // дала бы вторую тревогу об одной и той же подписке.
      //
      // Подписки здесь ещё нет: платежа не было. Её проставит крон удержания,
      // когда первый платёж приедет из ЮKassa.
      await tx.customer.upsert({
        where: { leadId: deal.leadId },
        create: { leadId: deal.leadId, dealId: deal.id, status: "ACTIVE" },
        // Возврат клиента после ухода — снова активен, но факты о платежах
        // не трогаем: их пересчитывает крон из операций.
        update: { status: "ACTIVE", dealId: deal.id, missedSignalKey: null, missedSignalAt: null },
      });
    }

    await tx.domainEvent.create({
      data: {
        module: "sales",
        type: "deal.stage_changed",
        title: `${deal.title}: ${fromStage?.name ?? "?"} → ${toStage.name}`,
        payload: meta,
      },
    });
  });

  logInfo("sales.deal_moved", {
    dealId: deal.id,
    from: deal.stageId,
    to: toStage.id,
    lostReason: input.lostReason ?? undefined,
  });

  return { dealId: deal.id, fromStageId: deal.stageId, toStageId: toStage.id, moved: true };
}

/** Стадии воронки слева направо — как их показывает канбан. */
export async function loadStages() {
  return prisma.pipelineStage.findMany({ orderBy: { position: "asc" } });
}
