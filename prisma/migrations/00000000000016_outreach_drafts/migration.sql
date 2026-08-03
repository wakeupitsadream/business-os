-- Черновики аутрича.
--
-- Система НИЧЕГО не отправляет: черновик копируется или открывается deep-link'ом
-- в мессенджере, а «Отправлено» владелец отмечает сам. Массовая автоматическая
-- рассылка от его лица ставит под удар и номер, и репутацию продукта, ради
-- которого всё делается.
--
-- `editedBody` отдельно от `body`: правки владельца — это образцы его тона, на
-- них учатся следующие черновики. Затирать оригинал значило бы потерять
-- сравнение «что предложили» против «что он написал на самом деле».
-- CreateEnum
CREATE TYPE "OutreachChannel" AS ENUM ('TELEGRAM', 'WHATSAPP', 'EMAIL', 'PHONE');

-- CreateEnum
CREATE TYPE "OutreachStatus" AS ENUM ('PENDING', 'APPROVED', 'SENT', 'REPLIED', 'NO_REPLY', 'REJECTED');

-- CreateTable
CREATE TABLE "OutreachDraft" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "dealId" TEXT,
    "channel" "OutreachChannel" NOT NULL DEFAULT 'TELEGRAM',
    "body" TEXT NOT NULL,
    "editedBody" TEXT,
    "reasoning" TEXT,
    "status" "OutreachStatus" NOT NULL DEFAULT 'PENDING',
    "approvedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutreachDraft_status_createdAt_idx" ON "OutreachDraft"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OutreachDraft_leadId_createdAt_idx" ON "OutreachDraft"("leadId", "createdAt");

-- AddForeignKey
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

