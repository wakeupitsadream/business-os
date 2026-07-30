-- CreateEnum
CREATE TYPE "CheckInKind" AS ENUM ('MORNING', 'EVENING');

-- CreateEnum
CREATE TYPE "JournalKind" AS ENUM ('NOTE', 'DAY_SUMMARY', 'WEEKLY_RETRO', 'MONTHLY_REVIEW');

-- CreateEnum
CREATE TYPE "JournalAuthor" AS ENUM ('OWNER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('ACTIVE', 'DONE', 'PAUSED', 'DROPPED');

-- DropIndex
DROP INDEX "MemoryFact_embedding_hnsw_idx";

-- CreateTable
CREATE TABLE "LifeArea" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "color" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LifeArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LifeAreaScore" (
    "id" TEXT NOT NULL,
    "areaId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LifeAreaScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckIn" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "kind" "CheckInKind" NOT NULL DEFAULT 'EVENING',
    "mood" INTEGER,
    "energy" INTEGER,
    "stress" INTEGER,
    "note" TEXT,
    "source" "EntitySource" NOT NULL DEFAULT 'TELEGRAM',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "kind" "JournalKind" NOT NULL DEFAULT 'NOTE',
    "authoredBy" "JournalAuthor" NOT NULL DEFAULT 'OWNER',
    "title" TEXT,
    "content" TEXT NOT NULL,
    "dayKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Goal" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "areaId" TEXT,
    "metricName" TEXT,
    "targetValue" INTEGER,
    "currentValue" INTEGER,
    "isMoney" BOOLEAN NOT NULL DEFAULT false,
    "deadline" TIMESTAMP(3),
    "status" "GoalStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyBrief" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "content" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "focus" TEXT,
    "sentToTelegramAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyBrief_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LifeArea_slug_key" ON "LifeArea"("slug");

-- CreateIndex
CREATE INDEX "LifeAreaScore_period_idx" ON "LifeAreaScore"("period");

-- CreateIndex
CREATE UNIQUE INDEX "LifeAreaScore_areaId_period_key" ON "LifeAreaScore"("areaId", "period");

-- CreateIndex
CREATE INDEX "CheckIn_date_idx" ON "CheckIn"("date");

-- CreateIndex
CREATE UNIQUE INDEX "CheckIn_date_kind_key" ON "CheckIn"("date", "kind");

-- CreateIndex
CREATE INDEX "JournalEntry_kind_createdAt_idx" ON "JournalEntry"("kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_kind_dayKey_key" ON "JournalEntry"("kind", "dayKey");

-- CreateIndex
CREATE INDEX "Goal_status_deadline_idx" ON "Goal"("status", "deadline");

-- CreateIndex
CREATE UNIQUE INDEX "DailyBrief_date_key" ON "DailyBrief"("date");

-- AddForeignKey
ALTER TABLE "LifeAreaScore" ADD CONSTRAINT "LifeAreaScore_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "LifeArea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "LifeArea"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Сид сфер жизни: «колесо баланса» без сфер бессмысленно, а заводить их
-- вручную владелец не станет. Восемь — проверенный практикой набор: меньше
-- теряет важное, больше превращает ежемесячную самооценку в анкету.
-- ON CONFLICT DO NOTHING делает миграцию безопасной при повторном применении.
INSERT INTO "LifeArea" (id, slug, name, icon, "sortOrder", "isActive", "createdAt") VALUES
  ('area_business',  'business',  'Бизнес',        '💼', 1, true, now()),
  ('area_finance',   'finance',   'Финансы',       '💰', 2, true, now()),
  ('area_health',    'health',    'Здоровье',      '🏃', 3, true, now()),
  ('area_relations', 'relations', 'Отношения',     '❤️', 4, true, now()),
  ('area_growth',    'growth',    'Развитие',      '📚', 5, true, now()),
  ('area_rest',      'rest',      'Отдых',         '🌿', 6, true, now()),
  ('area_home',      'home',      'Быт',           '🏠', 7, true, now()),
  ('area_meaning',   'meaning',   'Смысл',         '🧭', 8, true, now())
ON CONFLICT (slug) DO NOTHING;
