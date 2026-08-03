-- Контент-модуль: посты канала от идеи до публикации.
--
-- Номер 18: 9–11 заняты аудит-ветками, 12–16 — стопкой продаж, 17 — правкой
-- дедупа сведённых переводов. Одинаковые префиксы у независимых миграций
-- Prisma не заметит, но каталог после этого читается как ребус.
--
-- Про статусы PUBLISHING и UNCERTAIN стоит сказать отдельно, потому что они
-- выглядят избыточными, а на деле держат весь модуль. Публикация в канал
-- необратима: второй пост увидят подписчики, и удалять его придётся руками.
-- PUBLISHING — атомарный захват поста прогоном крона (планировщик стреляет
-- следующий прогон, не дожидаясь предыдущего). UNCERTAIN — исход, про который
-- мы не знаем, случился он или нет: таймаут отправки, 502 от прокси, смерть
-- контейнера посреди джобы. Из UNCERTAIN система сама не выходит: решает
-- владелец, посмотрев канал.
-- CreateEnum
CREATE TYPE "ContentChannel" AS ENUM ('TELEGRAM', 'VK');

-- CreateEnum
CREATE TYPE "ContentRubric" AS ENUM ('CASE', 'NICHE_PAIN', 'FEATURE', 'BEHIND_SCENES', 'DIGEST');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('IDEA', 'DRAFT', 'APPROVED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'UNCERTAIN', 'FAILED', 'REJECTED');

-- CreateTable
CREATE TABLE "ContentPost" (
    "id" TEXT NOT NULL,
    "channel" "ContentChannel" NOT NULL DEFAULT 'TELEGRAM',
    "status" "ContentStatus" NOT NULL DEFAULT 'IDEA',
    "rubric" "ContentRubric" NOT NULL,
    "groupKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "editedBody" TEXT,
    "reasoning" TEXT,
    "regenNote" TEXT,
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "media" BYTEA,
    "mediaMime" TEXT,
    "mediaName" TEXT,
    "planKey" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "externalId" TEXT,
    "externalUrl" TEXT,
    "publishingAt" TIMESTAMP(3),
    "publishAttempts" INTEGER NOT NULL DEFAULT 0,
    "publishError" TEXT,
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentPost_scheduledAt_idx" ON "ContentPost"("scheduledAt");

-- CreateIndex
CREATE INDEX "ContentPost_status_scheduledAt_idx" ON "ContentPost"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "ContentPost_status_createdAt_idx" ON "ContentPost"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ContentPost_groupKey_idx" ON "ContentPost"("groupKey");

-- CreateIndex
CREATE INDEX "ContentPost_planKey_idx" ON "ContentPost"("planKey");

