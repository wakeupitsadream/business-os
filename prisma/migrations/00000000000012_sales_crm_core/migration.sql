-- CRM-ядро модуля «Продажи»: воронка, лиды, сделки, касания, follow-up.
--
-- Два решения, которые видно только здесь.
--
-- 1. `Lead.phoneNormalized` УНИКАЛЕН. Это первый и самый надёжный уровень
--    дедупа: один и тот же автосервис приезжает из Яндекса, из 2ГИС и из
--    заявки на сайте под тремя разными названиями, но с одним номером. NULL в
--    Postgres не конфликтует сам с собой, поэтому лид без телефона (обычное
--    дело у входящих с сайта) ограничение не трогает.
--
-- 2. `Deal.enteredStageAt` — отдельное поле, а не `updatedAt`. Время на стадии
--    и «застрявшие сделки» считаются по нему; `updatedAt` двигает любая правка,
--    и сделка, которой поменяли название, выглядела бы свежей.
-- CreateEnum
CREATE TYPE "LeadNiche" AS ENUM ('AUTO_SERVICE', 'PRIVATE_MASTER', 'OTHER');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('INBOUND_SITE', 'YANDEX_GEO', 'TWO_GIS', 'MANUAL', 'REFERRAL');

-- CreateEnum
CREATE TYPE "LostReason" AS ENUM ('PRICE', 'NO_NEED', 'COMPETITOR', 'NO_ANSWER', 'BAD_TIMING', 'OTHER');

-- CreateEnum
CREATE TYPE "TouchKind" AS ENUM ('NOTE', 'CALL', 'MESSAGE_TG', 'MESSAGE_WA', 'EMAIL', 'MEETING', 'STAGE_CHANGE');

-- CreateEnum
CREATE TYPE "FollowUpStatus" AS ENUM ('PENDING', 'DONE', 'SKIPPED');

-- CreateEnum
CREATE TYPE "FollowUpOrigin" AS ENUM ('AUTO_RULE', 'AI_SUGGESTION', 'MANUAL');

-- CreateTable
CREATE TABLE "PipelineStage" (
    "id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "probability" INTEGER NOT NULL,
    "staleAfterDays" INTEGER,
    "isWon" BOOLEAN NOT NULL DEFAULT false,
    "isLost" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PipelineStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "niche" "LeadNiche" NOT NULL DEFAULT 'AUTO_SERVICE',
    "city" TEXT,
    "source" "LeadSource" NOT NULL DEFAULT 'MANUAL',
    "phoneNormalized" TEXT,
    "site" TEXT,
    "address" TEXT,
    "note" TEXT,
    "aiScore" INTEGER,
    "aiScoreData" JSONB,
    "aiNextStep" JSONB,
    "nextFollowUpAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "telegram" TEXT,
    "isPersonalData" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deal" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "enteredStageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "amountMonthlyKop" INTEGER NOT NULL DEFAULT 0,
    "lostReason" "LostReason",
    "trialEndsAt" TIMESTAMP(3),
    "financeTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TouchPoint" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "dealId" TEXT,
    "kind" "TouchKind" NOT NULL,
    "body" TEXT,
    "meta" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "EntitySource" NOT NULL DEFAULT 'WEB',

    CONSTRAINT "TouchPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowUp" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "dealId" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "status" "FollowUpStatus" NOT NULL DEFAULT 'PENDING',
    "origin" "FollowUpOrigin" NOT NULL DEFAULT 'MANUAL',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PipelineStage_position_key" ON "PipelineStage"("position");

-- CreateIndex
CREATE INDEX "PipelineStage_position_idx" ON "PipelineStage"("position");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_phoneNormalized_key" ON "Lead"("phoneNormalized");

-- CreateIndex
CREATE INDEX "Lead_niche_city_idx" ON "Lead"("niche", "city");

-- CreateIndex
CREATE INDEX "Lead_aiScore_idx" ON "Lead"("aiScore");

-- CreateIndex
CREATE INDEX "Lead_nextFollowUpAt_idx" ON "Lead"("nextFollowUpAt");

-- CreateIndex
CREATE INDEX "Contact_leadId_idx" ON "Contact"("leadId");

-- CreateIndex
CREATE INDEX "Deal_stageId_enteredStageAt_idx" ON "Deal"("stageId", "enteredStageAt");

-- CreateIndex
CREATE INDEX "Deal_leadId_idx" ON "Deal"("leadId");

-- CreateIndex
CREATE INDEX "TouchPoint_leadId_occurredAt_idx" ON "TouchPoint"("leadId", "occurredAt");

-- CreateIndex
CREATE INDEX "TouchPoint_occurredAt_idx" ON "TouchPoint"("occurredAt");

-- CreateIndex
CREATE INDEX "FollowUp_status_dueAt_idx" ON "FollowUp"("status", "dueAt");

-- CreateIndex
CREATE INDEX "FollowUp_leadId_status_idx" ON "FollowUp"("leadId", "status");

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "PipelineStage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TouchPoint" ADD CONSTRAINT "TouchPoint_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TouchPoint" ADD CONSTRAINT "TouchPoint_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─── Сид воронки ───
--
-- Стадии заданы миграцией, а не экраном настроек. Пользователь один, воронка
-- меняется раз в год, а редактор стадий пришлось бы поддерживать всегда — и
-- он же первым сломал бы отчёты, если стадию удалить вместе со сделками.
--
-- `probability` — не украшение: из неё считается взвешенный потенциал воронки,
-- то есть «сколько денег тут реально, а не по списку».
-- `staleAfterDays` у терминальных стадий NULL: застрять в «выиграно» нельзя.
INSERT INTO "PipelineStage" (id, position, name, probability, "staleAfterDays", "isWon", "isLost") VALUES
  ('stage_new',       1, 'Новый',      5,   3,    false, false),
  ('stage_contacted', 2, 'Связались',  15,  5,    false, false),
  ('stage_demo',      3, 'Демо',       40,  7,    false, false),
  ('stage_trial',     4, 'Пробный',    65,  14,   false, false),
  ('stage_won',       5, 'Выиграно',   100, NULL, true,  false),
  ('stage_lost',      6, 'Проиграно',  0,   NULL, false, true)
ON CONFLICT (id) DO NOTHING;
