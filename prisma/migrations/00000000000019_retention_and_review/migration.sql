-- Удержание и еженедельный разбор — последний шаг фазы «Продажи».
--
-- Про Transaction.subscriptionId стоит сказать отдельно. Значение и раньше
-- приезжало с платежом ЮKassa, но лежало внутри meta -> 'metadata'. Крон
-- удержания ходит по нему на каждом прогоне, а поиск по пути внутри Json — это
-- скан всей таблицы операций, самой большой в системе: выражательный индекс
-- при path-фильтре не применяется. Поэтому колонка, индекс и бэкфилл ниже.
--
-- Колонка заполняется ТОЛЬКО у строки дохода. Синк пишет на один платёж две
-- строки — доход и комиссию эквайринга; продублировав ключ на вторую, мы
-- удвоили бы счётчик платежей клиента и сломали якорь ожидаемой даты.
-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'AT_RISK', 'CHURNED');

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "subscriptionId" TEXT;

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "dealId" TEXT,
    "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
    "subscriptionId" TEXT,
    "mrrKop" INTEGER NOT NULL DEFAULT 0,
    "anchorDay" INTEGER,
    "firstPaymentAt" TIMESTAMP(3),
    "lastPaymentAt" TIMESTAMP(3),
    "paymentsCount" INTEGER NOT NULL DEFAULT 0,
    "expectedNextAt" TIMESTAMP(3),
    "missedSignalKey" TEXT,
    "missedSignalAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesReview" (
    "id" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "weekKey" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "report" TEXT,
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "actionsTaken" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_leadId_key" ON "Customer"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_subscriptionId_key" ON "Customer"("subscriptionId");

-- CreateIndex
CREATE INDEX "Customer_status_expectedNextAt_idx" ON "Customer"("status", "expectedNextAt");

-- CreateIndex
CREATE UNIQUE INDEX "SalesReview_weekStart_key" ON "SalesReview"("weekStart");

-- CreateIndex
CREATE INDEX "SalesReview_weekStart_idx" ON "SalesReview"("weekStart");

-- CreateIndex
CREATE INDEX "Transaction_subscriptionId_date_idx" ON "Transaction"("subscriptionId", "date");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Бэкфилл: у уже записанных платежей ключ подписки лежит в meta.
UPDATE "Transaction"
SET "subscriptionId" = "meta"->'metadata'->>'subscriptionId'
WHERE "source" = 'YOOKASSA'
  AND "type" = 'INCOME'
  AND "meta"->'metadata'->>'subscriptionId' IS NOT NULL;
