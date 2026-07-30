-- Виртуальный счёт «ЮKassa».
--
-- Поступления от клиентов приходят не на банковский счёт, а на баланс
-- эквайера, и оттуда выводятся пачками. Класть их сразу на карту значит
-- показать деньги, которых на карте ещё нет, и разойтись с банком на всю
-- сумму невыведенного остатка.
--
-- Вывод на расчётный счёт потом опознается импортом выписки как перевод
-- между своими счетами — механизм уже написан.
--
-- ON CONFLICT DO NOTHING делает миграцию безопасной при повторном применении.

INSERT INTO "Account" (id, name, kind, currency, "openingBalanceKop", "openingDate", "isArchived", "isDefault", "createdAt", "updatedAt") VALUES
  ('acc_yookassa', 'ЮKassa', 'YOOKASSA', 'RUB', 0, now(), false, false, now(), now())
ON CONFLICT (id) DO NOTHING;

-- Правила для комиссии эквайринга уже есть у категории cat_fees
-- (миграция 00000000000006), сюда добавляем только явное название операции,
-- которое пишет синк.
UPDATE "Category"
SET rules = COALESCE(rules, '[]'::jsonb) || '[{"contains": "КОМИССИЯ ЭКВАЙРИНГА"}]'::jsonb
WHERE id = 'cat_fees'
  AND NOT (COALESCE(rules, '[]'::jsonb) @> '[{"contains": "КОМИССИЯ ЭКВАЙРИНГА"}]'::jsonb);
