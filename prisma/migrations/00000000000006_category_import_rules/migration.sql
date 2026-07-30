-- Правила автокатегоризации импорта.
--
-- Без них импорт выписки раскладывает по категориям только то, что поймали
-- алиасы, — а алиасы написаны под речь владельца («потратил на бензин»), не под
-- названия мерчантов («AZS LUKOIL 0345»). MCC решает это точнее любого текста:
-- код присваивает платёжная система, и 5541 означает заправку независимо от
-- того, как назвал себя магазин.
--
-- Правила лежат данными, а не кодом, чтобы владелец мог поправить их из
-- интерфейса, не дожидаясь деплоя. Идентификаторы категорий заданы сидом
-- миграции 00000000000005 — UPDATE по несуществующему id просто ничего не
-- сделает, поэтому миграция безопасна при повторном применении.

UPDATE "Category" SET rules = '[
  {"mcc": 5541}, {"mcc": 5542}, {"mcc": 5172}, {"mcc": 4121}, {"mcc": 7523},
  {"contains": "АЗС"}, {"contains": "ЛУКОЙЛ"}, {"contains": "ГАЗПРОМНЕФТЬ"},
  {"contains": "ЯНДЕКС ТАКСИ"}, {"contains": "YANDEX TAXI"}, {"contains": "ПАРКОВКА"}
]'::jsonb WHERE id = 'cat_transport';

UPDATE "Category" SET rules = '[
  {"mcc": 5812}, {"mcc": 5814}, {"mcc": 5411}, {"mcc": 5499},
  {"contains": "ПЯТЕРОЧКА"}, {"contains": "МАГНИТ"}, {"contains": "ПЕРЕКРЕСТОК"},
  {"contains": "ВКУСВИЛЛ"}, {"contains": "САМОКАТ"}, {"contains": "ДЕЛИВЕРИ"}
]'::jsonb WHERE id = 'cat_food';

UPDATE "Category" SET rules = '[
  {"mcc": 5912}, {"mcc": 8011}, {"mcc": 8062}, {"mcc": 7997},
  {"contains": "АПТЕКА"}, {"contains": "ЗДОРОВЬЕ"}, {"contains": "КЛИНИКА"}
]'::jsonb WHERE id = 'cat_health';

UPDATE "Category" SET rules = '[
  {"mcc": 4814}, {"mcc": 4899},
  {"contains": "МТС"}, {"contains": "БИЛАЙН"}, {"contains": "МЕГАФОН"},
  {"contains": "TELE2"}, {"contains": "РОСТЕЛЕКОМ"}
]'::jsonb WHERE id = 'cat_communication';

UPDATE "Category" SET rules = '[
  {"mcc": 7311}, {"mcc": 7310},
  {"contains": "ЯНДЕКС ДИРЕКТ"}, {"contains": "YANDEX DIRECT"},
  {"contains": "VK РЕКЛАМА"}, {"contains": "ADS"}, {"contains": "РЕКЛАМ"}
]'::jsonb WHERE id = 'cat_ads';

UPDATE "Category" SET rules = '[
  {"contains": "TIMEWEB"}, {"contains": "ТАЙМВЕБ"}, {"contains": "REG.RU"},
  {"contains": "CLOUDFLARE"}, {"contains": "SELECTEL"}, {"contains": "БЕГЕТ"},
  {"contains": "ХОСТИНГ"}, {"contains": "ДОМЕН"}
]'::jsonb WHERE id = 'cat_hosting';

UPDATE "Category" SET rules = '[
  {"contains": "OPENAI"}, {"contains": "ANTHROPIC"}, {"contains": "POLZA"},
  {"contains": "PROXYAPI"}, {"contains": "НЕЙРОСЕТ"}
]'::jsonb WHERE id = 'cat_ai';

UPDATE "Category" SET rules = '[
  {"mcc": 5734}, {"mcc": 5817}, {"mcc": 5818},
  {"contains": "GITHUB"}, {"contains": "FIGMA"}, {"contains": "NOTION"},
  {"contains": "JETBRAINS"}, {"contains": "ПОДПИСКА"}
]'::jsonb WHERE id = 'cat_saas';

UPDATE "Category" SET rules = '[
  {"mcc": 9311}, {"mcc": 9399},
  {"contains": "НАЛОГ"}, {"contains": "ФНС"}, {"contains": "УСН"},
  {"contains": "СТРАХОВЫЕ ВЗНОСЫ"}, {"contains": "ПАТЕНТ"}
]'::jsonb WHERE id = 'cat_taxes';

UPDATE "Category" SET rules = '[
  {"contains": "КОМИССИЯ"}, {"contains": "ЭКВАЙРИНГ"}, {"contains": "ЮKASSA"},
  {"contains": "YOOKASSA"}, {"contains": "РКО"}
]'::jsonb WHERE id = 'cat_fees';

UPDATE "Category" SET rules = '[
  {"mcc": 6513},
  {"contains": "АРЕНДА"}, {"contains": "ЖКХ"}, {"contains": "КОММУНАЛ"},
  {"contains": "ЭНЕРГОСБЫТ"}
]'::jsonb WHERE id = 'cat_home';

UPDATE "Category" SET rules = '[
  {"mcc": 8299}, {"mcc": 5942},
  {"contains": "ЛИТРЕС"}, {"contains": "УДЕМИ"}, {"contains": "UDEMY"},
  {"contains": "КУРС"}, {"contains": "ОБУЧЕНИЕ"}
]'::jsonb WHERE id = 'cat_education';

-- Доходы: назначение платежа от клиента.
UPDATE "Category" SET rules = '[
  {"contains": "ОПЛАТА ПОДПИСКИ"}, {"contains": "АБОНЕНТСКАЯ ПЛАТА"},
  {"contains": "ПРОДЛЕНИЕ ТАРИФА"}
]'::jsonb WHERE id = 'cat_subscriptions';

UPDATE "Category" SET rules = '[
  {"contains": "ЗА УСЛУГИ"}, {"contains": "ЗА РАЗРАБОТКУ"}, {"contains": "ПО ДОГОВОРУ"},
  {"contains": "ВНЕДРЕНИЕ"}, {"contains": "НАСТРОЙКА"}
]'::jsonb WHERE id = 'cat_services';
