-- Суточная квота внешних API лидогена — в таблице, а не в памяти процесса.
--
-- Счётчик в памяти обнуляется на каждом деплое: три деплоя за день, и суточный
-- кап пробит втрое, причём молча. Бесплатный тир Geosearch кончится в середине
-- месяца, а владелец узнает об этом по пустой выдаче.
--
-- День по UTC, а не по поясу владельца: сутки владельца (UTC+5) начинаются
-- раньше, и счётчик обнулялся бы до того, как обнулится квота у провайдера, —
-- то есть кап переставал бы защищать ровно в тот момент, ради которого заведён.
CREATE TABLE IF NOT EXISTS "ConnectorQuota" (
    "id" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectorQuota_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ConnectorQuota_connector_day_key"
  ON "ConnectorQuota"("connector", "day");
CREATE INDEX IF NOT EXISTS "ConnectorQuota_day_idx" ON "ConnectorQuota"("day");
