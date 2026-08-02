-- Джобы лидогена и кандидаты в лиды.
--
-- Кандидаты живут отдельно от `Lead` намеренно. Источник отдаёт мусор
-- вперемешку с полезным, и высыпать его прямо в CRM значит убить CRM. Плюс
-- третий уровень дедупа (похожие названия) требует решения владельца —
-- кандидату надо где-то ждать этого решения, не притворяясь лидом.
--
-- `ParsedCompany.phoneNormalized` НЕ уникален, в отличие от `Lead`: та же
-- компания из двух источников — две законные строки-кандидата, склеиваются
-- они при импорте в лид.
--
-- GIN-индекс по названию лида — под третий уровень дедупа: без него
-- `similarity()` читает всю таблицу лидов на каждого импортируемого кандидата.
-- Расширение pg_trgm включено ещё в 00000000000000_init_extensions.
-- CreateEnum
CREATE TYPE "ParseJobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CandidateStatus" AS ENUM ('NEW', 'IMPORTED', 'SKIPPED');

-- CreateTable
CREATE TABLE "ParseJob" (
    "id" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "rubric" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "niche" "LeadNiche" NOT NULL DEFAULT 'AUTO_SERVICE',
    "status" "ParseJobStatus" NOT NULL DEFAULT 'PENDING',
    "cursor" JSONB,
    "stats" JSONB,
    "error" TEXT,
    "lockedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ParseJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParsedCompany" (
    "id" TEXT NOT NULL,
    "jobId" TEXT,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "niche" "LeadNiche" NOT NULL DEFAULT 'AUTO_SERVICE',
    "city" TEXT,
    "address" TEXT,
    "phones" TEXT[],
    "phoneNormalized" TEXT,
    "site" TEXT,
    "rating" DOUBLE PRECISION,
    "reviewsCount" INTEGER,
    "isPersonalData" BOOLEAN NOT NULL DEFAULT false,
    "raw" JSONB,
    "score" INTEGER,
    "scoreData" JSONB,
    "status" "CandidateStatus" NOT NULL DEFAULT 'NEW',
    "leadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ParsedCompany_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ParseJob_status_createdAt_idx" ON "ParseJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ParsedCompany_status_score_idx" ON "ParsedCompany"("status", "score");

-- CreateIndex
CREATE INDEX "ParsedCompany_jobId_idx" ON "ParsedCompany"("jobId");

-- CreateIndex
CREATE INDEX "ParsedCompany_phoneNormalized_idx" ON "ParsedCompany"("phoneNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "ParsedCompany_source_externalId_key" ON "ParsedCompany"("source", "externalId");

-- CreateIndex
CREATE INDEX "Lead_name_idx" ON "Lead" USING GIN ("name" gin_trgm_ops);

-- AddForeignKey
ALTER TABLE "ParsedCompany" ADD CONSTRAINT "ParsedCompany_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ParseJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

