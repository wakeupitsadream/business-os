-- Ключ идемпотентности входящей заявки — колонкой, а не полем внутри Json.
--
-- По нему ищут на КАЖДЫЙ запрос от agentus.space, а поиск по пути внутри
-- jsonb — это последовательный скан всей таблицы касаний. Уникальный индекс
-- заодно переносит гарантию из кода в базу: два одновременных ретрая Agentus
-- (сеть моргнула, ответ потерялся) не заведут двух лидов.
--
-- NULL у всех остальных касаний и сам с собой не конфликтует.
ALTER TABLE "TouchPoint" ADD COLUMN IF NOT EXISTS "inboundExternalId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "TouchPoint_inboundExternalId_key"
  ON "TouchPoint"("inboundExternalId");
