# План: «Business OS» — персональный центр управления бизнес-жизнью

## Контекст

Максим (владелец Agentus) хочет единое приложение — «пульт всей бизнес-жизни»:
десктоп + веб-доступ с телефона. Четыре направления: Разработка, Финансы,
Продажи, Секретарь/поддержка. Вдохновение — концепт «Claude AI Company OS»
(тёмная тема, оранжевый акцент, командные центры-«отделы», ИИ-агент со статусом
ACTIVE, KPI-карточки, ленты активности). Проект greenfield: **новый приватный
репозиторий `business-os`**, ничего общего с кодом Agentus, но переиспользуем
его проверенные инфраструктурные паттерны (файлы-эталоны указаны ниже).

План собран оркестратором из 5 параллельных дизайн-документов + ревью критика;
все найденные противоречия разрешены и зафиксированы здесь как канон.

---

## 1. Зафиксированные решения (канон, не пересматривать)

1. **Клиент**: одна кодовая база Next.js; десктоп — тонкая обёртка **Tauri v2**
   (окно на прод-URL; Electron не нужен — нет глубокой нативщины); мобильный —
   responsive web + PWA с того же сервера.
2. **Один пользователь** (владелец). Без мультитенантности, но вся «личность»
   изолирована в Settings/env — мысленный тест «завтра второй пользователь».
3. **ИИ-ядро**: Claude Sonnet — диалоги/советники, Opus (`heavy`) — редкие
   глубокие разборы, дешёвая модель (`cheap`) — классификация/парсинг/скоринг.
   Доступ через OpenAI-совместимые агрегаторы: каскад `polza → proxyapi`.
4. **Порядок модулей**: Фаза 0 (каркас) → Секретарь → Финансы → Продажи →
   полировка (Tauri/PWA/хаб) → «Разработка» (фаза 2 продукта).
5. **Хостинг**: Timeweb App Platform, один Docker-контейнер (Next standalone +
   встроенный планировщик). БД — **Neon** (serverless PostgreSQL, pgvector
   поддерживается: `CREATE EXTENSION vector`). Регион — ближайший к Timeweb
   (eu-central/Франкфурт), латентность учтена. **Отключить scale-to-zero**
   (или принять cold-start ~0.5–1 с): минутный крон напоминаний и вебхуки TG
   не должны ждать пробуждения БД. Prisma с Neon: pooled-строка (`-pooler`,
   PgBouncer) в `DATABASE_URL` + прямая строка в `DIRECT_URL`
   (`directUrl` в datasource — для миграций).
   Vercel отклонён: фоновые парсеры, долгие агентные циклы, TG-бот и
   планировщик требуют постоянного процесса.
6. **Telegram**: личный бот (НЕ бот Agentus); весь трафик через CF Worker
   прокси; **вебхук ставится на Worker с форвардом на прод** (урок инцидента
   Agentus 10.07.2026 — прямая доставка TG→РФ-хостинг ретраится минутами).
   Доступ — статический env-allowlist `TELEGRAM_OWNER_CHAT_ID` (без механизма
   привязки по ссылке — упрощение для одного пользователя).
7. **Массового автоаутрича нет** (блокировки + ФЗ «О рекламе»): только
   персонализированные черновики на одобрение, отправка руками владельца.
8. **Парсинг лидов — только легальные пути**: официальные API 2ГИС (Catalog
   API) и Яндекс (Geosearch); Avito — только ручной co-pilot (владелец
   вставляет URL/текст, ИИ структурирует). Скрапинг страниц каталогов запрещён
   (ст. 1334 ГК РФ, 152-ФЗ для физлиц-мастеров, прецедент «ВК vs Double Data»).

### Канонические конвенции (разрешённые противоречия)
- **Деньги**: `Int` в **копейках** везде (Transaction, Deal, Budget, Goal).
  Предел ~21,4 млн ₽ на операцию — достаточно; проверка переполнения при
  импорте; агрегаты в SQL (SUM(int)→bigint — само ок).
- **Диалоги**: одна пара моделей `Conversation`/`Message` (web и TG — общая
  история). **Память**: один `MemoryFact` с инлайновым `embedding
  Unsupported("vector(1536)")` (отдельной MemoryEmbedding нет).
- **Фоновые задачи MVP**: паттерн Agentus «cron-роут делает работу сам,
  идемпотентно» (НЕ универсальная JobQueue — отложена до фазы 1.5; для
  длинных резюмируемых работ есть доменные сущности `ImportBatch`, `ParseJob`
  с курсором).
- **Учёт LLM**: таблица `LlmUsage`, пишется в LLM-шлюзе на **каждый** вызов
  (поле `feature`), с первого дня. AgentRun хранит только ссылки/агрегат.
- **Полевого шифрования в MVP нет** (модель угроз: ключ в env того же контура
  = иллюзия защиты; плюс plaintext всё равно нужен для эмбеддингов). Что
  делаем: ключи интеграций только в env; privacy mode в UI (маскировка сумм);
  TLS `sslmode=verify-full`; бэкапы; удаление сырых выписок через 30 дней.
- **«Уровни дохода → руководства к действию»** — только в Финансах
  (`FinancialGoal kind=playbook`, статус-машина `armed→triggered→acknowledged`).
  Секретарь на них ссылается, бриф упоминает сработавшие.
- **Синк ЮKassa — каждые 6 часов**, инкрементально с перекрытием −48ч,
  отдельный read-only ключ того же магазина (вебхуки заняты Agentus'ом).
- Чек-ины: шкала **1–5**. Сессия: TTL **30 дней** скользящий. Повторы
  напоминаний: **пресеты** (ежедневно/будни/еженедельно/ежемесячно) +
  денормализованный `nextFireAt` — полный RRULE-парсер не делаем.
- STT: провайдер и модель в конфиге (`STT_PROVIDER=proxyapi`,
  `STT_MODEL=gpt-4o-mini-transcribe`; fallback Yandex SpeechKit).
- Тема (единый источник — `src/styles/theme`): фон `#0A0A0B`, поверхности
  `#121214`/`#1A1A1E`, бордер `#26262B`, акцент `#FF6B00`, текст `#EDEDEF`/
  `#8B8B93`, ok `#22C55E`, warn `#F59E0B`, danger `#EF4444`; шрифты Inter +
  JetBrains Mono (KPI-цифры, статусы, таймстемпы). Только тёмная тема.

---

## 2. Архитектура

### 2.1. Репозиторий (одно приложение, без монорепо)

```
business-os/
├── Dockerfile                      # 3 стадии, по образцу Agentus
├── next.config.ts                  # output: "standalone"
├── prisma/schema.prisma + migrations/   # включая ручную миграцию pgvector+HNSW
├── scripts/start-container.mjs     # порт из Agentus: миграции → server → cron-цикл
├── scripts/db-migrate-safe.mjs     # порт из Agentus
├── desktop/                        # Tauri v2 (не участвует в Docker-сборке)
│   └── src-tauri/{tauri.conf.json, Cargo.toml, src/main.rs}
├── .github/workflows/{ci.yml, desktop-release.yml}
└── src/
    ├── app/
    │   ├── (auth)/login/
    │   ├── (os)/                   # защищённый layout: сайдбар «отделов»
    │   │   ├── page.tsx            # HQ-дашборд (фаза полировки)
    │   │   ├── secretary/  finance/  sales/  settings/
    │   └── api/
    │       ├── health/  auth/  chat/ (SSE-стрим)  stt/
    │       ├── telegram/webhook/
    │       └── cron/[job]/         # по CRON_SECRET
    ├── modules/                    # «отделы»: самодостаточные папки
    │   ├── secretary/ {agent.ts, tools.ts, briefing.ts, ui/}
    │   ├── finance/   {tools.ts, metrics.ts, insights.ts, import/, yookassa.ts, ui/}
    │   └── sales/     {tools.ts, ai.ts, connectors/, ui/}
    ├── core/
    │   ├── llm/          # gateways.ts (каскад polza→proxyapi), complete/embed/extract, LlmUsage
    │   ├── orchestrator/ # agent-loop.ts, tool-registry.ts (Zod-схемы, dangerous-флаг → approval)
    │   ├── memory/       # профиль владельца, MemoryFact, векторный поиск (raw SQL <=>)
    │   ├── auth/         # argon2-пароль, jose JWT-cookie, middleware
    │   ├── telegram/     # bot.ts (через TELEGRAM_API_BASE), voice.ts
    │   └── shared/       # zod-схемы DTO, константы, money-utils (копейки)
    ├── components/os/    # KpiCard, Sparkline, ActivityFeed, AgentStatusBadge, KanbanBoard, DrawerCard
    └── styles/           # тема-токены (@theme Tailwind v4)
```

### 2.2. Стек

Next.js ^15.4 (App Router, standalone) · React ^19.1 · TS ^5.8 strict ·
Prisma ^6 (`extensions=[vector]`, embedding-колонки через ручной SQL/
`Unsupported("vector(1536)")` + HNSW-индекс в ручной миграции) ·
Tailwind ^4.1 + shadcn/ui (перекрашен токенами) · Recharts ^3 ·
TanStack Query ^5 (polling 30с на MVP; SSE-шина — в фазе полировки; чат —
стрим в ответе POST /api/chat) · **Zod v4** · jose ^6 · @node-rs/argon2 ·
openai SDK ^5 (как клиент OpenAI-совместимых шлюзов) · date-fns ^4 +
**@date-fns/tz** · vitest ^4 · Tauri v2 (plugins: tray, global-shortcut,
notification, updater, deep-link).

Без tRPC (Server Actions + Route Handlers с Zod достаточно; tRPC мешает SSE и
ничего не даёт одному клиенту). Без Redis (in-memory rate-limit, cron-direct).

### 2.3. ИИ-оркестратор

- **Шлюз** (`core/llm/gateways.ts`, эталон — `/home/user/agentus/src/lib/llm/gateways.ts`
  + `circuit-breaker.ts`): `LLM_GATEWAYS=polza,proxyapi`; пресеты-роли
  `smart` (Sonnet) / `heavy` (Opus) / `cheap` / `embed` (text-embedding-3-small,
  1536); ретрай 429/5xx со сдвигом на следующий шлюз; **каждый** вызов пишет
  `LlmUsage {feature, gateway, model, tokens, costRub}`.
- **Agent loop** (`core/orchestrator/agent-loop.ts`), один для всех отделов:
  AgentRun → контекст (системный промпт + профиль владельца + BusinessSnapshot
  + top-8 MemoryFact по вектору + pinned + окно истории 20 сообщений) → цикл
  tool-calling (max 8 итераций, аргументы валидируются Zod) → AgentAction на
  каждый вызов → финальный ответ. Инструменты с `dangerous: true` не
  исполняются, а создают Notification `approval_required` (кнопки в UI и TG).
- **Память**: (1) профиль-«конституция» в Settings — всегда в промпте;
  (2) MemoryFact c pinned/importance — top-K по вектору; (3) дневник/саммари
  дня. Извлечение фактов — раз в сутки в джобе day-summary дешёвой моделью
  (не при каждом сообщении). Векторный дедуп/supersede — фаза 1.5.
- **BusinessSnapshot** (`getBusinessSnapshot()`, кэш 15 мин): MRR, расходы
  месяца, runway, топ-категории, лиды по стадиям, просроченные follow-up —
  компактный блок ~500 токенов в промпт секретаря. Модули пишут значимые
  события в `DomainEvent` — сырьё брифа и инсайтов.

### 2.4. Ядро схемы БД (канон; доменные модели — в §3–5)

`Settings` (singleton: displayName, timezone Europe/Moscow, ownerProfile Json,
uiPrefs) · `Conversation`/`Message` (role, content, toolCalls Json, tokens;
channel web|telegram) · `AgentRun`/`AgentAction` (журнал агентов) ·
`MemoryFact` (text, category, pinned, importance, embedding vector(1536)) ·
`Task` (status TODO|IN_PROGRESS|DONE|CANCELLED, priority, dueAt, areaId?,
goalId?, source) · `Reminder` (text, nextFireAt UTC, repeatPreset?, channel,
isActive) · `Notification` (type info|warning|approval_required|digest,
payload, resolution) · `DomainEvent` (module, type, payload, occurredAt) ·
`LlmUsage` (feature, gateway, model, inTokens, outTokens, costRub, createdAt).

### 2.5. Auth и безопасность

Пароль: `OWNER_PASSWORD_HASH` (argon2id) → cookie `bos_session` (jose JWT,
httpOnly, Secure, SameSite=Lax, TTL 30 дней скользящий). Middleware закрывает
всё, кроме `/login`, `/api/health`, `/api/telegram/webhook`, `/api/cron/*`
(свои секреты). Rate-limit логина 5/15мин in-memory. TG: allowlist
`TELEGRAM_OWNER_CHAT_ID` + `X-Telegram-Bot-Api-Secret-Token`, дедуп по
`update_id`. Tauri использует ту же cookie-сессию WebView. Секреты — только
env; в промпты не попадают; sensitive-поля маскируются в AgentAction-журнале.

### 2.6. Деплой

Dockerfile — 3 стадии по эталону `/home/user/agentus/Dockerfile`: node:22-alpine,
`prisma generate` → `next build`, git SHA в `.build-sha` (отдаётся в
`/api/health`), `NODE_OPTIONS=--dns-result-order=ipv4first` (урок Agentus),
HEALTHCHECK curl **без** `-f`, `CMD node scripts/start-container.mjs`
(миграции db-migrate-safe → server.js → минутный cron-цикл). `/api/health`:
`{ok, gitSha, db, uptime}` — статус БД не влияет на HTTP-код. CI: typecheck +
vitest + build как гейт PR; деплой — автодеплой Timeweb по пушу в `main`,
мёрж = релиз, прямой пуш в main запрещён.

Env: `DATABASE_URL` (Neon pooled, `sslmode=require`) + `DIRECT_URL` (Neon
direct, для миграций), `AUTH_SECRET`, `OWNER_PASSWORD_HASH`,
`CRON_SECRET`, `LLM_GATEWAYS`, `POLZA_API_KEY`, `PROXYAPI_API_KEY`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_API_BASE`, `TELEGRAM_WEBHOOK_SECRET`,
`TELEGRAM_OWNER_CHAT_ID`, `YOOKASSA_SHOP_ID/SECRET_KEY` (read-only),
`YANDEX_GEO_API_KEY`, `DGIS_API_KEY`, `STT_PROVIDER/STT_MODEL`, `APP_URL`.

### 2.7. Tauri-обёртка (фаза полировки)

Окно 1440×900 на прод-URL (dev — localhost), тёмный фон окна (без белой
вспышки); трей (статус + непрочитанные, закрытие → в трей); глобальный хоткей
`Ctrl/Cmd+Shift+Space` → окно «quick capture» (`/capture`: быстрая
заметка/расход/задача); системные уведомления (страница пробрасывает события в
Notification API); deep-link `businessos://`; auto-update оболочки через
GitHub Releases (`desktop-release.yml`, matrix Windows NSIS + macOS dmg;
нотаризацию macOS в MVP пропускаем). Детекция: `window.__TAURI_INTERNALS__`.

---

## 3. Модуль «Секретарь» (приоритет №1)

### Функции MVP
Чат (web SSE-стрим + TG, общая история) · утренний бриф 07:30 МСК (задачи,
напоминания, вчерашние финансы, новые лиды, «фокус дня», 1 вопрос-чекин) ·
задачи и напоминания (голосом/текстом) · чек-ины настроение/энергия 1–5
(TG inline-кнопки) · колесо баланса (8 сфер, ежемесячная самооценка 1–10,
радар-чарт) · цели (3–5 активных, метрика, дедлайн; `currentValue`
обновляется джобой из модулей) · дневник (записи + автосаммари дня).

Фаза 1.5–2: тайм-блокинг плана дня, привычки со стриками (только позитивное
подкрепление), еженедельная ретроспектива, ежемесячный обзор жизни,
карточки «Рекомендации руководителю», сессия «/застой» (детект: низкие
чек-ины ≥5 дней + нет закрытых задач → 5 вопросов → 5 идей → 1 микрошаг).

### Психология и мотивация — этичные рамки (в системном промпте)
Роль: «Ася» — личный секретарь-заместитель; тон: русский, «ты», тепло и
по-деловому, до 6 предложений, честность важнее приятности. Принципы: сначала
tool-call, потом подтверждение; цифры только из данных; при низкой
энергии/настроении — снижать нагрузку, не давить. Мотивация к прибыли — только
прозрачные nudges с фактами («до цели 150к MRR не хватает 38к ≈ 4 клиента
Стандарт — показать тёплых лидов?»), целеполагание, стрики; запрещены: вина,
страх, FOMO, сравнение с другими. Границы: НЕ терапевт/врач, без диагнозов;
при маркерах серьёзного дистресса — бережно рекомендовать специалиста;
необратимые действия с деньгами/внешние отправки — никогда сама.

### Данные (Prisma)
`LifeArea` (8 сфер, сид) · `LifeAreaScore` (@@unique [areaId, period "2026-07"]) ·
`CheckIn` (date, kind, mood/energy/stress 1–5, note; @@unique [date, kind]) ·
`JournalEntry` (kind NOTE|DAY_SUMMARY|WEEKLY_RETRO|MONTHLY_REVIEW, content md,
authoredBy, embedding) · `Goal` (title, areaId, metricName, targetValue/
currentValue **в копейках** для денежных, deadline, status; финансовые пороги —
ссылка на FinancialGoal, НЕ дублируются) · `Habit`/`HabitLog` (фаза 1.5) ·
`DailyBrief` (date @unique, content md, data Json, focus, sentToTelegramAt).

### Инструменты секретаря
`create_task, list_tasks, complete_task, set_reminder, log_expense` (делегат в
Финансы), `query_finance, sales_query, save_memory_fact, journal_write,
get_day_plan, checkin`. Черновики наружу — `dangerous` → approval.

### Telegram-бот
Транспорт: `TELEGRAM_API_BASE` (CF Worker) исходящие; вебхук на Worker →
форвард на прод (эталон `/home/user/agentus/src/lib/messaging/telegram-webhook.ts`).
Голос: voice → getFile через прокси → OGG ≤60с → STT (конфиг) → «🎙 Понял
так: …» → обычный пайплайн. Команды: `/brief`, `/plan`, `/task <текст>`
(без LLM), `/checkin` (inline-клавиатура), `/idea`, `/stuck`; напоминания с
кнопками [Готово][+1 час][Завтра]; ответы >4096 — сплит.

### UI `/secretary`
KPI-ряд: настроение/энергия + 7-дн спарклайн · задачи сегодня (done/total,
просрочка красным) · фокус дня · стрик. Левая колонка: бриф-карточка, план
дня (таймлайн, чекбоксы), рекомендации, колесо баланса (радар). Правая
колонка фикс.: чат-панель (стрим, карточки tool-calls «✔ Расход 1 200 ₽ →
Транспорт», кнопка диктовки MediaRecorder → `/api/stt`). Низ: лента
активности (DomainEvent). Подстраницы: goals, journal, habits, memory
(просмотр/пин/удаление фактов — прозрачность памяти обязательна).

### Кроны (UTC; МСК = UTC+3)
`daily-brief` 04:30 · `reminders` каждую минуту (`isActive AND nextFireAt <=
now()` → отправка → пересчёт по пресету) · `evening-checkin` 18:30 ·
`day-summary` 19:00 (саммари + извлечение MemoryFact дешёвой моделью) ·
`weekly-retro` пт 12:00 · `monthly-review` 1-е 05:00 · `insights` 03:00 ·
`goal-sync` 02:00. Все идемпотентны (unique по дате), таймаут ≤5 мин.

---

## 4. Модуль «Финансы»

**Ключевой принцип: все цифры считает код; LLM только интерпретирует** —
никогда не источник чисел на KPI.

### Функции
Операции (доход/расход/перевод; счёт+категория обязательны, проект Agentus/
Личное/…, source manual|secretary_chat|telegram|import_csv|import_pdf|
yookassa|recurring) · бюджеты по категориям (ok <80% / warning / over) ·
KPI MTD: выручка/расходы/прибыль/кэшфлоу (+% день-в-день к прошлому месяцу),
runway = остатки ÷ средний burn 3 мес, MRR Agentus · прогноз 6 мес
(детерминированный: RecurringItem + тренд 3 мес; один базовый сценарий на
MVP, сценарии-полосы позже) · AI-инсайты · playbooks · цели по доходу
(линия цели на графике, комментарий темпа).

**Периоды считаются по дате операции в Europe/Moscow** (periodKey "2026-07").

### Ввод данных
1. **Быстрая форма** (модалка, хоткей N, Enter) и **NL через секретаря**:
   tool `add_transaction {type, amountKop, categoryHint, projectHint, date,
   note}` («3тр»→3000, «вчера» резолвит код); маппинг категории: алиасы
   (`Category.aliases`) → при неудаче cheap-LLM «выбери из списка». Запись
   сразу + строка-подтверждение «✅ … Исправить?»; суммы >50 000 ₽ — сначала
   подтверждение. Голос в TG — тот же пайплайн.
2. **Импорт выписок**: загрузка (bytea в БД на MVP, ≤10 МБ) → детект формата →
   известные CSV (Т-Банк: `;`, cp1251; Сбер) детерминированными плагин-парсерами
   `BankStatementParser` → неизвестные CSV и PDF: текст (pdf-parse; сканы вне
   MVP) → чанки ~50 строк → cheap-LLM structured output → **контрольная сверка
   сумм с итогами шапки выписки** (расхождение → перегон → needs_review) →
   автокатегоризация (правила rules/MCC → батч-LLM остатка) → предпросмотр
   (new|duplicate|internal_transfer — зеркальные суммы ±1 день) → коммит
   транзакцией → откат «удалить импорт целиком». Дедуп: `dedupKey =
   sha256(accountId|день|сумма|нормализованное описание)`,
   `@@unique([accountId, dedupKey])`; `rawFile` удаляется через 30 дней.
3. **ЮKassa** (каждые 6 ч): `GET /v3/payments?created_at.gte=lastSyncedAt−48h
   &status=succeeded` (Basic Auth shopId:secretKey, cursor-пагинация; позже
   `/v3/refunds`). Маппинг: `income_amount` → операция дохода, разница с
   `amount` → парная операция «Комиссия эквайринга»; metadata (subscriptionId)
   → признак MRR + матчинг на Deal/Customer в Продажах; `@@unique([source,
   externalId])`; счёт «ЮKassa» виртуальный, вывод на р/с матчится при импорте
   выписки как transfer.

### Данные (Prisma)
`Account` (kind bank_card|bank_account|cash|yookassa, openingBalanceKop,
lastSyncedAt) · `Project` · `Category` (type, parentId 2 уровня, aliases[],
rules Json, isBusiness) · `Transaction` (amountKop Int >0, type задаёт знак;
transferAccountId; externalId; dedupKey; importBatchId; индексы по date/
category/project) · `Budget` (month, categoryId, **projectId NOT NULL со
спец-проектом «—»** — обход NULL≠NULL в unique) · `RecurringItem` (cadence,
nextDueDate, autoCreate) · `FinancialGoal` (kind target|playbook, metric,
direction gte|lte, thresholdKop, playbookMd, status
active|armed|triggered|acknowledged|achieved) · `Insight` (kind, severity,
title, bodyMd, factsJson, actions Json, dedupKey @unique, status) ·
`ImportBatch` · `FinanceSnapshot` (periodKey @unique, data Json).

### Движок инсайтов
Детерминированный слой (`finance/metrics.ts`, ночной): тренды MoM по
категориям/проектам, аномалии (>mean+2σ за 6 мес, операция >p95), топ-3
концентрация, runway и его динамика, бюджет-алерты, «зомби-подписки»,
эффективная ставка эквайринга, прогресс целей, срабатывание playbooks.
Шаблонные инсайты (превышение бюджета, playbook, аномалия) — **без LLM**.
LLM-слой (раз в сутки + по кнопке, Sonnet): компактный JSON фактов (не сырые
операции) + цели + прошлые инсайты 30 дней (антиповтор) → tool
`create_insights` (до 3 карточек) → валидация: `referencedFacts` обязаны
существовать, суммы в actions — из фактов; «Показать расчёт» из factsJson.
Действия карточек MVP: `navigate` | `tell_secretary` | `dismiss`.

### UI `/finance`
KPI-строка 6 карточек (выручка/расходы/прибыль/кэшфлоу/runway/MRR + спарклайны)
· revenue bar+line 12 мес с линией цели · донат расходов топ-6 (клик →
фильтр ленты) · cash flow по месяцам · forecast 6 мес · лента операций
(виртуализация, inline-правка категории, бейджи источника) + [+ Операция]
[Импорт] · стопка AI INSIGHT-карточек · privacy mode (глазок → суммы «•••»).
Подстраницы: import (мастер), budgets, goals (+playbook-редактор), recurring,
reports. Экспорт: CSV/JSON полный + full-backup.json (данные не заперты).

### Кроны
`yookassa-sync` каждые 6 ч · `finance-recalc` 00:30 (снапшоты, прогноз,
детерминированные инсайты, пороги playbooks) · `finance-insights` 03:00 (LLM)
· `recurring-due` 01:00 (+напоминание в TG за 2 дня) · `monthly-report` 1-е
04:00 (P&L по проектам, сравнение с бюджетом, LLM-резюме → TG + бриф).

---

## 5. Модуль «Продажи»

### CRM-ядро
`Lead` (ниша AUTO_SERVICE|PRIVATE_MASTER, город, контакты, phoneNormalized
@unique для дедупа, источник, aiScore/aiScoreData, aiNextStep,
nextFollowUpAt) · `Contact` (isPersonalData → авто-очистка по 152-ФЗ) ·
`Deal` (stageId, amountMonthlyKop, lostReason enum обязателен при lost,
trialEndsAt, financeTransactionId, enteredStageAt) · `TouchPoint` (лента
касаний: NOTE|CALL|MESSAGE_TG|…|STAGE_CHANGE) · `FollowUp` (status, origin
auto_rule|ai_suggestion|manual — метрика дисциплины касаний) ·
`PipelineStage` (сид: new 5% → contacted 15% → demo 40% → trial 65% → won →
lost; staleAfterDays для авто-follow-up; UI редактирования стадий не делаем) ·
**`Customer`** (создаётся при won; связь с ЮKassa-платежами по metadata
subscriptionId; сигнал «платёж не пришёл в ожидаемую дату» → задача
«связаться» — это выполняет требование «удержание имеющихся») ·
`SalesReview` (weekStart @unique, metrics Json, report md).

Интеграция с Финансами: won → связь с транзакцией дохода; churn-сигналы из
синка ЮKassa. **Входящие лиды с agentus.space**: эндпоинт
`POST /api/sales/inbound` с общим секретом (Agentus дергает при заявке) +
мгновенный TG-пуш с черновиком первого ответа.

### Лидогенерация (легальная стратегия — канон)
Коннекторы (`sales/connectors/`, интерфейс единый): `YandexGeoApiConnector`
(официальный Geosearch API, бесплатный тир — стартуем с него; суточный кап в
конфиге) → `TwoGisApiConnector` (Catalog API, подключить после оформления
ключа/тарифа) → `ManualImportConnector` (co-pilot Avito: владелец вставляет
URL/текст → cheap-LLM структурирует в поля). `ParseJob` (query {city, rubric},
status, cursor Json — резюмируемость, stats) исполняется кроном
`parse-runner` каждые 15 мин (одна джоба за тик, advisory lock). Без
Playwright в MVP (оба API — чистый HTTP JSON). Троттлинг: requestsPerMinute +
dailyCap на коннектор (счётчики в таблице). `ParsedCompany`: название, ниша,
город, адрес, телефоны, сайт, рейтинг, отзывы, raw Json, externalId+source
(@@unique), isPersonalData (физлица: минимальный состав, авто-очистка через
6 мес без конверсии — крон `pd-retention-cleanup`).

Дедуп 3 уровня: [source, externalId] → phoneNormalized merge → нечёткий
(name+city, pg_trgm >0.6) с ручным подтверждением при импорте в Lead.

### ИИ-скоринг (cheap-LLM, батчами)
Вход: ParsedCompany + первые 2КБ главной страницы сайта лида (свой сайт — не
каталог, риска нет). Выход: score 0–100 + signals (hasSite, siteQuality,
reviewsCount, repliesToReviews, hasOnlineBooking, socialActivity) + fitReason
+ suggestedPitch. Эвристика: нет онлайн-записи + поток отзывов = горячий;
score ≥60 → вкладка «Горячие кандидаты» → кнопка «В CRM».

### ИИ в CRM
«Что дальше?» по лиду: structured output `{nextAction, channel, suggestedDate,
draftMessage, reasoning}` (cheap; Sonnet для demo/trial). Аутрич: черновики
персонализированные (≤20/день), очередь на одобрение, отправка только руками
(кнопка «Скопировать» + deep-link t.me/wa.me), «Отправлено» → TouchPoint +
авто-follow-up через 3 дня. `OutreachDraft` (status PENDING→APPROVED→SENT→
REPLIED|NO_REPLY, editedBody — правки владельца как few-shot тона).
Еженедельный разбор (`sales-weekly-review`, пн 04:00 UTC): SQL-метрики
(конверсии, время на стадии, застрявшие, причины lost, дисциплина касаний,
качество источников) → Sonnet → 3 вывода + узкое место + 3 действия недели
(кнопкой → FollowUp) + идея удержания → карточка + сжатая версия в бриф.

### Контент-маркетинг
`ContentPost` (channel TG|VK, status IDEA→DRAFT→APPROVED→SCHEDULED→PUBLISHED,
groupKey кросс-канальной связки, rubric: кейс|боль ниши|фича|внутрянка|
дайджест). Недельный план: 3–5 идей (антиповтор по последним 20 постам).
Генерация Sonnet few-shot из одобренных постов + инлайн-редактор +
«перегенерировать с комментарием». Календарь (месяц/неделя, drag-n-drop).
Автопостинг TG-канала кроном `publish-content` (бот-админ канала, через
прокси); VK в MVP — полуавто (пуш «пора публиковать» + отметка), `wall.post`
— фаза 2. mediaUrl — то же bytea-хранилище, что выписки.

### UI `/sales`
KPI: активные сделки (шт/₽ MRR-потенциал), конверсия new→won 30 дн, новые
лиды за неделю, касаний сегодня, MRR. Центр: канбан-воронка (drag-n-drop,
lost — модалка причины; won/lost свёрнуты счётчиками). Справа: лента
TouchPoint + системные события, донат источников, карточка weekly review.
Вкладки: Воронка | Лиды (таблица, фильтры) | Лидоген (джобы + кандидаты) |
Аутрич (очередь) | Контент (календарь). Карточка лида — drawer: контакты,
скоринг, «ИИ: следующий шаг» (оранжевая рамка), лента касаний, сделки.

---

## 6. Дорожная карта (PR-ы с DoD)

Темп: соло + Claude Code, ~15–20 ч/нед, PR = 0.5–2 дня. Правило: не начинать
фазу N+1, пока фаза N не используется ежедневно ≥1 недели.

### Фаза 0 — Каркас (нед 1–2)
- **PR-0.1 Скелет**: Next 15 + TS strict + Tailwind 4 + тема-токены + layout
  сайдбара отделов (заглушки). DoD: build зелёный, каркас открывается.
- **PR-0.2 БД**: Prisma + каноническая схема ядра (§2.4) + ручная миграция
  pgvector/HNSW + db-migrate-safe. DoD: миграции идемпотентны на пустой БД.
- **PR-0.3 Docker+Timeweb+планировщик**: Dockerfile, start-container.mjs,
  /api/health, первый крон heartbeat. DoD: пуш в main → автодеплой,
  health отвечает, heartbeat виден в логах.
- **PR-0.4 Auth**: пароль/argon2 + JWT-cookie 30 дней + middleware +
  rate-limit. DoD: без логина — редирект.
- **PR-0.5 LLM-шлюз**: каскад polza→proxyapi + circuit-breaker + LlmUsage.
  DoD: /api/dev/llm-ping отвечает через Polza с фолбэком; usage в БД.
- **PR-0.6 Telegram**: CF Worker (копия/route), вебхук на Worker → форвард,
  allowlist, дедуп update_id; эхо-бот с LLM. DoD: бот отвечает владельцу,
  чужим — отказ; переписка в Conversation/Message.

*Польза: «умный Claude-чат» в личном TG уже работает.*

### Фаза 1 — Секретарь (нед 2–5)
- **PR-1.1 Агентное ядро**: agent-loop + tool-registry + журнал + системный
  промпт Аси. DoD: юнит-тесты цикла на моках; тестовый tool работает.
- **PR-1.2 Задачи и напоминания**: tools + крон reminders. DoD: «напомни
  завтра в 10 позвонить в банк» из TG срабатывает вовремя (МСК/UTC верно).
- **PR-1.3 Утренний бриф + память** ← точка ежедневной пользы. DoD: бриф
  приходит ежедневно; факт недельной давности вспоминается по запросу.
- **PR-1.4 Голос**: STT-пайплайн + /api/stt для веба. DoD: голосовое
  «поставь задачу» работает; ошибки STT деградируют вежливо.
- **PR-1.5 Сферы и чек-ины**: LifeArea/CheckIn/Goal + вечерний чек-ин +
  day-summary. DoD: неделя чек-инов → осмысленный недельный отчёт.
- **PR-1.6 UI Секретаря**: чат (общая история с TG), задачи, чек-ины, лента.
  DoD: диалог из TG продолжается в вебе; responsive.

### Фаза 2 — Финансы (нед 5–8)
- **PR-2.1 Модель + ручной ввод + NL** (DoD: «потратил 3500 на бензин»
  голосом → операция с категорией; запросы сумм верны).
- **PR-2.2 UI Финансов** (DoD: цифры сходятся с БД, мобайл ок).
- **PR-2.3 Импорт выписок** (DoD: реальные CSV+PDF Т-Банк/Сбер импортируются,
  повторный импорт без дублей, контрольная сумма сверена).
- **PR-2.4 ЮKassa-синк 6 ч** (DoD: платежи Agentus появляются без дублей,
  комиссия отдельной операцией).
- **PR-2.5 Метрики + инсайты + playbooks + месячный отчёт** (DoD: отчёт 1-го
  числа в TG; рекомендации ссылаются только на реальные цифры).

### Фаза 3 — Продажи (нед 8–12)
- **PR-3.1 CRM-ядро** (модели+сиды, канбан, drawer, TouchPoint/FollowUp,
  утренний дайджест касаний). DoD: лид проходит воронку drag-n-drop.
- **PR-3.2 Входящие с agentus.space** (эндпоинт+секрет, TG-пуш с черновиком).
  DoD: тестовая заявка в воронке <5 мин.
- **PR-3.3 Лидоген**: Яндекс Geosearch → co-pilot Avito → скоринг → (2ГИС
  после ключа). DoD: запуск «автосервисы × [город]» даёт скорингованных
  кандидатов в пределах суточного лимита API (ожидания сверить с тиром),
  дубли отсеяны по телефону.
- **PR-3.4 Аутрич-черновики** (DoD: черновики персонализированы, «отправлено
  вручную» двигает воронку).
- **PR-3.5 Контент** (DoD: недельный план за 1 клик, календарь, автопост в
  TG-канал).
- **PR-3.6 Удержание + weekly review** (Customer + churn-сигнал ЮKassa).
  DoD: еженедельный отчёт с реальными конверсиями; пропуск платежа создаёт
  задачу «связаться».

### Фаза 4 — Полировка v1 (нед 12–14)
- **PR-4.1 HQ-дашборд** (KPI всех отделов, лента, статусы агентов — «вау-экран»).
- **PR-4.2 PWA** (manifest, SW, установка на телефон; DoD: Lighthouse installable).
- **PR-4.3 Tauri v2** (§2.7; DoD: .exe/.dmg запускается, логинится, трей и
  хоткей работают).
- **PR-4.4 Надёжность**: бэкапы (Neon point-in-time restore/branching +
  недельный pg_dump в S3-хранилище),
  алерты об ошибках в TG, дашборд LlmUsage с дневным лимитом-алертом.
- **PR-4.5 Лоск**: пустые состояния, скелетоны, хоткеи, SSE-шина `/api/events`
  вместо polling.

### Фаза 5 — «Разработка» (фаза 2 продукта, нед 14–17, эскиз)
Панель проектов: GitHub API (PAT) — PR/CI/коммиты/issues; статус деплоев —
health-чеки продуктов + вебхуки GitHub. Запуск ИИ-задач: карточка → GitHub
Issue → Claude Code GitHub Action (`@claude`) → PR → ревью/мёрж из панели;
уведомления секретаря «PR готов, CI зелёный». Anthropic API из GitHub-раннеров
доступен напрямую (не РФ) — ограничения обходятся элегантно. Расходы Action
учитываются в Финансах.

---

## 7. Чек-лист ручных шагов владельца

**До фазы 0**: создать приватный репо `business-os` (✅ сделано) · ключ Polza
(`POLZA_API_KEY`, пополнить) · ключ ProxyAPI (резерв) · **Neon**: создать
проект (регион eu-central), в SQL-консоли `CREATE EXTENSION IF NOT EXISTS
vector;`, отключить scale-to-zero (Settings → Compute), взять две строки
подключения: pooled (`-pooler`) → `DATABASE_URL` и direct → `DIRECT_URL`;
allowlist IP не нужен ·
· Timeweb App: приложение из репо (Dockerfile, ветка main) + все env ·
поддомен `os.<домен>` + HTTPS · сгенерировать AUTH_SECRET / CRON_SECRET /
OWNER_PASSWORD_HASH.

**Для TG (PR-0.6)**: @BotFather → новый личный бот → токен · CF Worker: route
для нового бота + маршрут форварда вебхука (`TELEGRAM_WEBHOOK_SECRET`) ·
узнать свой chat_id (@userinfobot) → `TELEGRAM_OWNER_CHAT_ID` · setWebhook
на Worker.

**Для Финансов (фаза 2)**: ЮKassa — отдельный read-only ключ · выгрузить
тестовые выписки банка (CSV и PDF).

**Для Продаж (фаза 3)**: ключ Яндекс Geosearch API (`YANDEX_GEO_API_KEY`,
проверить актуальный бесплатный тир) · ключ 2ГИС Catalog API (dev.2gis.ru,
уточнить тариф) · выбрать города/ниши первого сбора · бота — админом в
TG-канал Agentus (для автопостинга).

**Для Разработки (фаза 5)**: GitHub PAT · Claude Code GitHub Action в целевые
репо + ANTHROPIC_API_KEY в секреты репо.

---

## 8. Риски и экономика

| Риск | Митигация |
|---|---|
| Polza деградирует/закроется | каскад шлюзов, смена = env; circuit-breaker |
| Лимиты/тарифы API каталогов | капы+очередь; co-pilot как фолбэк; DoD сверены с тирами |
| Объём работ соло / выгорание | польза на 3-й неделе; PR ≤2 дней; правило «фаза N+1 только после недели ежедневного использования N»; резать скоуп, не сроки |
| Стоимость токенов | роутинг cheap/smart; LlmUsage с дневным лимитом-алертом; окно истории + суммаризация |
| CF Worker/Telegram | паттерн год работает в Agentus; резервный Worker; веб-чат как дубль |
| Баги с личными финансами | все ИИ-мутации значимых сумм — с подтверждением; импорт с предпросмотром; AuditLog (AgentAction); vitest на финансовую арифметику; бэкапы |

**Стоимость LLM**: типовой месяц ~$100 ≈ 8–10 тыс ₽ (секретарь ~60 сообщ/день
на Sonnet ≈ $90; отчёты ≈ $8; рутина на cheap ≈ $3; STT ≈ $0.2). Диапазон:
экономный 3–4 тыс ₽ … интенсивный 20–25 тыс ₽/мес. Рычаги: обрезка истории,
prompt caching (если шлюз пробрасывает), Haiku вне «серьёзных» тем.

**Метрики успеха**: ≥90% дней с осмысленным использованием; бриф читается ≥5
дн/нед; ≥70% расходов вносятся в день совершения; 100% выручки ЮKassa
автоматом (расхождение 0); свести месяц <10 мин; реакция на входящий лид
<30 мин; ≥8 постов/мес; 0 пропущенных обязательств; LLM ≤10% атрибутируемого
прироста прибыли; аптайм ≥99%; восстановление из бэкапа отрепетировано ≤30 мин.

---

## 9. Верификация

- Каждый PR: `npm run typecheck && npm test` (vitest) зелёные — гейт CI;
  юнит-тесты обязательны для: money-utils (копейки), agent-loop (моки LLM),
  дедуп импорта, нормализация телефонов, пересчёт nextFireAt, метрики финансов.
- Смоук после деплоя: `/api/health` (gitSha совпадает с пушем, db up).
- E2E-сценарии руками по DoD каждого PR (перечислены выше) — прежде всего
  TG-сценарии: бриф, напоминание, голосовой расход, чек-ин.
- Тесты кириллицы в чатах — только python-клиентом/из UI, не curl из Git Bash
  (урок Agentus: CP1251-кракозябры).
- Финансовая сверка: после PR-2.4 сравнить сумму операций source=yookassa за
  месяц с кабинетом ЮKassa вручную.

## 10. Эталонные файлы Agentus (референсы паттернов, НЕ копипаст кода)

- `/home/user/agentus/scripts/start-container.mjs` — планировщик контейнера
- `/home/user/agentus/scripts/db-migrate-safe.mjs` — безопасные миграции
- `/home/user/agentus/Dockerfile` — 3-стадийная сборка (health без -f, ipv4first, .build-sha)
- `/home/user/agentus/src/lib/llm/gateways.ts` + `circuit-breaker.ts` — каскад шлюзов
- `/home/user/agentus/src/lib/messaging/telegram-webhook.ts`, `telegram.ts` — TG через CF Worker (вебхук на Worker!)
- `/home/user/agentus/src/lib/billing/yookassa.ts` — база read-only синка платежей
- `/home/user/agentus/src/lib/upload/extract-text.ts` — извлечение текста PDF
- `/home/user/agentus/src/lib/notifications/alert-admin.ts` — алерты себе в TG
- `/home/user/agentus/prisma/schema.prisma` — конвенции схемы; pgvector там добавлен raw SQL (embedding-колонка не в Prisma-схеме — в новом проекте используем `Unsupported("vector(1536)")` + ручной HNSW)
