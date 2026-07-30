-- CreateEnum
CREATE TYPE "AccountKind" AS ENUM ('BANK_CARD', 'BANK_ACCOUNT', 'CASH', 'YOOKASSA', 'OTHER');

-- CreateEnum
CREATE TYPE "TxType" AS ENUM ('INCOME', 'EXPENSE', 'TRANSFER');

-- CreateEnum
CREATE TYPE "TxSource" AS ENUM ('MANUAL', 'SECRETARY', 'TELEGRAM', 'IMPORT', 'YOOKASSA', 'RECURRING');

-- CreateEnum
CREATE TYPE "FinGoalKind" AS ENUM ('TARGET', 'PLAYBOOK');

-- CreateEnum
CREATE TYPE "FinGoalStatus" AS ENUM ('ACTIVE', 'ARMED', 'TRIGGERED', 'ACKNOWLEDGED', 'ACHIEVED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "InsightKind" AS ENUM ('ANOMALY', 'TREND', 'BUDGET_ALERT', 'RECOMMENDATION', 'PLAYBOOK_TRIGGER', 'MONTHLY_REPORT');

-- CreateEnum
CREATE TYPE "InsightSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL', 'OPPORTUNITY');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('UPLOADED', 'PARSING', 'PREVIEW', 'NEEDS_REVIEW', 'COMMITTED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "AccountKind" NOT NULL DEFAULT 'BANK_CARD',
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "openingBalanceKop" INTEGER NOT NULL DEFAULT 0,
    "openingDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMP(3),
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "color" TEXT,
    "isPersonal" BOOLEAN NOT NULL DEFAULT false,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "TxType" NOT NULL,
    "parentId" TEXT,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rules" JSONB,
    "isBusiness" BOOLEAN NOT NULL DEFAULT true,
    "icon" TEXT,
    "color" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "type" "TxType" NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amountKop" INTEGER NOT NULL,
    "accountId" TEXT NOT NULL,
    "transferAccountId" TEXT,
    "categoryId" TEXT,
    "projectId" TEXT,
    "counterparty" TEXT,
    "note" TEXT,
    "source" "TxSource" NOT NULL DEFAULT 'MANUAL',
    "externalId" TEXT,
    "dedupKey" TEXT,
    "importBatchId" TEXT,
    "recurringItemId" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "month" TIMESTAMP(3) NOT NULL,
    "categoryId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "plannedKop" INTEGER NOT NULL,
    "rollover" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "TxType" NOT NULL,
    "amountKop" INTEGER NOT NULL,
    "categoryId" TEXT,
    "projectId" TEXT,
    "accountId" TEXT,
    "cadence" TEXT NOT NULL DEFAULT 'monthly',
    "nextDueDate" TIMESTAMP(3) NOT NULL,
    "autoCreate" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialGoal" (
    "id" TEXT NOT NULL,
    "kind" "FinGoalKind" NOT NULL DEFAULT 'TARGET',
    "name" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'gte',
    "thresholdKop" INTEGER,
    "deadline" TIMESTAMP(3),
    "playbookMd" TEXT,
    "status" "FinGoalStatus" NOT NULL DEFAULT 'ACTIVE',
    "triggeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancialGoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Insight" (
    "id" TEXT NOT NULL,
    "kind" "InsightKind" NOT NULL,
    "severity" "InsightSeverity" NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "bodyMd" TEXT NOT NULL,
    "factsJson" JSONB NOT NULL DEFAULT '{}',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "periodKey" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Insight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "bankHint" TEXT,
    "format" TEXT NOT NULL DEFAULT 'csv',
    "status" "ImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "rawFile" BYTEA,
    "parsedRows" JSONB,
    "stats" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceSnapshot" (
    "id" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_name_key" ON "Project"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

-- CreateIndex
CREATE INDEX "Category_type_isArchived_idx" ON "Category"("type", "isArchived");

-- CreateIndex
CREATE UNIQUE INDEX "Category_name_type_key" ON "Category"("name", "type");

-- CreateIndex
CREATE INDEX "Transaction_date_idx" ON "Transaction"("date");

-- CreateIndex
CREATE INDEX "Transaction_type_date_idx" ON "Transaction"("type", "date");

-- CreateIndex
CREATE INDEX "Transaction_categoryId_date_idx" ON "Transaction"("categoryId", "date");

-- CreateIndex
CREATE INDEX "Transaction_projectId_date_idx" ON "Transaction"("projectId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_source_externalId_key" ON "Transaction"("source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_accountId_dedupKey_key" ON "Transaction"("accountId", "dedupKey");

-- CreateIndex
CREATE INDEX "Budget_month_idx" ON "Budget"("month");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_month_categoryId_projectId_key" ON "Budget"("month", "categoryId", "projectId");

-- CreateIndex
CREATE INDEX "RecurringItem_isActive_nextDueDate_idx" ON "RecurringItem"("isActive", "nextDueDate");

-- CreateIndex
CREATE INDEX "FinancialGoal_status_kind_idx" ON "FinancialGoal"("status", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Insight_dedupKey_key" ON "Insight"("dedupKey");

-- CreateIndex
CREATE INDEX "Insight_status_createdAt_idx" ON "Insight"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ImportBatch_status_createdAt_idx" ON "ImportBatch"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceSnapshot_periodKey_key" ON "FinanceSnapshot"("periodKey");

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_transferAccountId_fkey" FOREIGN KEY ("transferAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_recurringItemId_fkey" FOREIGN KEY ("recurringItemId") REFERENCES "RecurringItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringItem" ADD CONSTRAINT "RecurringItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringItem" ADD CONSTRAINT "RecurringItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringItem" ADD CONSTRAINT "RecurringItem_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─────────────────────────── Сид справочников ────────────────────────────────
--
-- Без справочников финансовый модуль неработоспособен: у операции обязателен
-- счёт, а категорию секретарь подбирает по алиасам. Заводить два десятка
-- категорий руками владелец не станет, поэтому базовый набор приезжает
-- миграцией. Идентификаторы заданы явно (не cuid) — так сид идемпотентен и на
-- него можно ссылаться из следующих миграций.

INSERT INTO "Account" (id, name, kind, currency, "openingBalanceKop", "openingDate", "isArchived", "isDefault", "createdAt", "updatedAt") VALUES
  ('acc_main', 'Основная карта', 'BANK_CARD', 'RUB', 0, now(), false, true,  now(), now()),
  ('acc_cash', 'Наличные',       'CASH',      'RUB', 0, now(), false, false, now(), now())
ON CONFLICT (id) DO NOTHING;

-- Спец-проект «—» существует ради уникальности бюджетов: в Postgres NULL ≠ NULL,
-- поэтому «бюджет на месяц+категорию без проекта» с nullable-полем можно было
-- бы завести дважды. Удалять его нельзя.
INSERT INTO "Project" (id, name, slug, color, "isPersonal", "isArchived", "createdAt") VALUES
  ('proj_none',     '—',       'none',     NULL,      false, false, now()),
  ('proj_agentus',  'Agentus', 'agentus',  '#F97316', false, false, now()),
  ('proj_personal', 'Личное',  'personal', '#64748B', true,  false, now())
ON CONFLICT (id) DO NOTHING;

-- Категории. aliases — то, чем владелец называет расход вслух: по ним
-- секретарь раскладывает «потратил 3500 на бензин» без обращения к модели.
-- Алиасы уникальны в пределах типа операции; совпадение «подписки» в доходах
-- и расходах допустимо — подбор всегда идёт с фильтром по типу.
INSERT INTO "Category" (id, name, type, "parentId", aliases, "isBusiness", icon, "sortOrder", "isArchived", "createdAt") VALUES
  -- Доходы
  ('cat_revenue',       'Выручка',              'INCOME',  NULL,           ARRAY['выручка','доход','поступление','оплата']::text[],                          true,  '💰', 10, false, now()),
  ('cat_subscriptions', 'Подписки клиентов',    'INCOME',  'cat_revenue',  ARRAY['подписка','тариф','продление','saas','абонплата']::text[],                  true,  '🔁', 11, false, now()),
  ('cat_services',      'Разовые услуги',       'INCOME',  'cat_revenue',  ARRAY['услуга','внедрение','настройка','консультация','разработка на заказ']::text[], true, '🛠', 12, false, now()),
  ('cat_other_income',  'Прочие поступления',   'INCOME',  NULL,           ARRAY['возврат','кэшбэк','проценты','прочий доход']::text[],                       false, '➕', 19, false, now()),

  -- Расходы: маркетинг
  ('cat_marketing',     'Маркетинг',            'EXPENSE', NULL,           ARRAY['маркетинг','продвижение']::text[],                                          true,  '📣', 20, false, now()),
  ('cat_ads',           'Реклама',              'EXPENSE', 'cat_marketing',ARRAY['реклама','таргет','директ','яндекс директ','вк реклама','ads','рся']::text[],true,  '🎯', 21, false, now()),
  ('cat_content',       'Контент',              'EXPENSE', 'cat_marketing',ARRAY['контент','копирайтер','дизайн','видео','съёмка','монтаж']::text[],          true,  '🎬', 22, false, now()),

  -- Расходы: инфраструктура
  ('cat_infra',         'Инфраструктура',       'EXPENSE', NULL,           ARRAY['инфраструктура']::text[],                                                   true,  '🖥', 30, false, now()),
  ('cat_hosting',       'Хостинг и серверы',    'EXPENSE', 'cat_infra',    ARRAY['хостинг','сервер','vps','timeweb','домен','днс','cdn','база данных']::text[],true, '☁️', 31, false, now()),
  ('cat_ai',            'ИИ и API',             'EXPENSE', 'cat_infra',    ARRAY['api','нейросеть','нейросети','llm','токены','openai','polza','модель']::text[],true,'🤖', 32, false, now()),
  ('cat_saas',          'Сервисы и подписки',   'EXPENSE', 'cat_infra',    ARRAY['подписка','сервис','github','figma','notion','лицензия']::text[],           true,  '🧩', 33, false, now()),

  -- Расходы: команда
  ('cat_team',          'Команда',              'EXPENSE', NULL,           ARRAY['команда']::text[],                                                          true,  '👥', 40, false, now()),
  ('cat_contractors',   'Подряд и фриланс',     'EXPENSE', 'cat_team',     ARRAY['фрилансер','подрядчик','исполнитель','разработчик','аутсорс']::text[],      true,  '🧑‍💻', 41, false, now()),
  ('cat_salary',        'Зарплата',             'EXPENSE', 'cat_team',     ARRAY['зарплата','зп','оклад','аванс']::text[],                                    true,  '💵', 42, false, now()),

  -- Расходы: налоги и банк
  ('cat_taxes_bank',    'Налоги и банк',        'EXPENSE', NULL,           ARRAY['налоги и банк']::text[],                                                    true,  '🏦', 50, false, now()),
  ('cat_taxes',         'Налоги и взносы',      'EXPENSE', 'cat_taxes_bank',ARRAY['налог','налоги','усн','ндфл','взносы','патент','фнс']::text[],             true,  '📑', 51, false, now()),
  ('cat_fees',          'Комиссии и эквайринг', 'EXPENSE', 'cat_taxes_bank',ARRAY['комиссия','эквайринг','юкасса','yookassa','банк','рко']::text[],           true,  '💳', 52, false, now()),

  -- Расходы: операционные
  ('cat_ops',           'Операционные',         'EXPENSE', NULL,           ARRAY['операционные','прочее','разное']::text[],                                   true,  '📦', 60, false, now()),
  ('cat_transport',     'Транспорт',            'EXPENSE', 'cat_ops',      ARRAY['бензин','топливо','заправка','такси','парковка','каршеринг','транспорт','метро']::text[], true, '🚗', 61, false, now()),
  ('cat_communication', 'Связь',                'EXPENSE', 'cat_ops',      ARRAY['связь','мобильный','интернет','телефон','сотовый']::text[],                 true,  '📱', 62, false, now()),
  ('cat_food',          'Питание',              'EXPENSE', 'cat_ops',      ARRAY['еда','обед','кафе','ресторан','продукты','кофе','доставка еды']::text[],    false, '🍽', 63, false, now()),
  ('cat_health',        'Здоровье',             'EXPENSE', 'cat_ops',      ARRAY['врач','аптека','лекарства','зал','спортзал','фитнес','анализы']::text[],    false, '🏥', 64, false, now()),
  ('cat_education',     'Обучение',             'EXPENSE', 'cat_ops',      ARRAY['курс','обучение','книга','книги','конференция','вебинар']::text[],          true,  '📚', 65, false, now()),
  ('cat_home',          'Дом',                  'EXPENSE', 'cat_ops',      ARRAY['аренда','квартира','коммуналка','жкх','дом','ремонт']::text[],              false, '🏠', 66, false, now())
ON CONFLICT (id) DO NOTHING;
