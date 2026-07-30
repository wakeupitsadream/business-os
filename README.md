# Business OS

Персональный «пульт бизнес-жизни» владельца: один вход, из которого видно и
управляется всё — секретарь-агент, финансы, продажи, задачи и напоминания.
Система рассчитана на **одного пользователя** (владельца), живёт в **одном
Docker-контейнере** и доступна из браузера, с телефона (Telegram-бот) и с
десктопа (обёртка Tauri, поздние фазы).

Полный план продукта и дорожная карта — [PLAN.md](./PLAN.md). Правила работы в
репозитории для ИИ-ассистента — [CLAUDE.md](./CLAUDE.md).

---

## Стек

| Слой | Что |
|---|---|
| Приложение | Next.js 15 (App Router, `output: "standalone"`), React 19, TypeScript strict |
| Данные | PostgreSQL 16 (**Neon**, serverless) + pgvector, Prisma 6 |
| Стили | Tailwind v4, тёмная тема «командный центр» (акцент `#FF6B00`) |
| LLM | Свой мульти-шлюз: Polza → ProxyAPI (OpenAI-совместимые, обычный `fetch`, без SDK) |
| Вход | Пароль владельца (argon2id) → JWT-cookie (jose), 30 дней скользящий |
| Каналы | Веб + Telegram-бот (через Cloudflare Worker) |
| Тесты | vitest (`globals: false`) |
| Хостинг | Timeweb App Platform, автодеплой по пушу в `main` |

---

## Быстрый старт локально

1. **База.** Создать проект в [Neon](https://neon.tech) (регион eu-central).
   В SQL-консоли проекта выполнить:

   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   ```

   В Settings → Compute **отключить scale-to-zero**: минутный крон напоминаний и
   вебхуки Telegram не должны ждать пробуждения базы.

   Взять две строки подключения: pooled (хост с суффиксом `-pooler`, добавить
   `&pgbouncer=true`) и direct (тот же хост без `-pooler`).

2. **Окружение.** Скопировать `.env.example` в `.env` и заполнить как минимум
   `DATABASE_URL` (pooled), `DIRECT_URL` (direct), `AUTH_SECRET`,
   `OWNER_PASSWORD_HASH`, `CRON_SECRET`.

   ```bash
   openssl rand -base64 48   # AUTH_SECRET
   openssl rand -hex 32      # CRON_SECRET
   ```

3. **Зависимости, схема, запуск.**

   ```bash
   npm i
   npx prisma migrate dev     # применит миграции, включая расширения
   npm run dev                # http://localhost:3000
   ```

4. **Проверки перед пушем** (то же гоняет CI):

   ```bash
   npm run typecheck && npm test
   ```

### Пароль владельца

Единственный замок на всей системе — пароль. Хэш генерируется локально:

```bash
npm run hash:password -- 'мой-длинный-пароль'
```

Скрипт печатает строку `OWNER_PASSWORD_HASH=…` — её значение кладётся в `.env`
(локально) и в переменные окружения приложения (на проде). Сам пароль нигде не
хранится.

---

## Деплой на Timeweb App Platform

Мёрж в `main` = релиз: платформа собирает образ и выкатывает его сама.

1. Создать приложение типа **Docker** из этого репозитория, ветка `main`,
   Dockerfile в корне, порт `3000`.
2. Задать переменные окружения (список и комментарии — в `.env.example`):
   `DATABASE_URL`, `DIRECT_URL`, `APP_URL`, `AUTH_SECRET`, `OWNER_PASSWORD_HASH`,
   `CRON_SECRET`, `LLM_GATEWAYS`, `POLZA_API_KEY`, `PROXYAPI_API_KEY`,
   `TELEGRAM_*`.
3. Домен не обязателен: на старте достаточно технического адреса, который
   выдаёт Timeweb. Свой поддомен привязывается позже — код от этого не зависит,
   меняются только `APP_URL` и `ORIGIN` у Worker'а.
4. После деплоя — смоук: `GET /api/health` должен вернуть `200`, поле `gitSha`
   совпадает с только что запушенным коммитом, `checks.database.ok = true`.

Что происходит при старте контейнера (`scripts/start-container.mjs`):

1. `scripts/db-migrate-safe.mjs` — `prisma migrate deploy`. Недоступная база
   **не** валит старт (предупреждение и продолжение), настоящая ошибка миграции
   (плохой SQL, дрейф) — валит.
2. Запуск `server.js` (standalone-сборка Next).
3. Встроенный планировщик: раз в ~20 с сверяет минуту UTC с расписанием и
   дёргает `http://127.0.0.1:3000/api/cron/<job>` с `Authorization: Bearer
   $CRON_SECRET`. Расписание Фазы 0: `heartbeat` каждые 10 минут,
   `cleanup-dedup` в 03:30 UTC. Новая задача добавляется в двух местах:
   обработчик — в `src/core/cron/registry.ts`, расписание — в
   `scripts/start-container.mjs`.

Полезные детали образа (менять только осознанно):

- `NODE_OPTIONS=--dns-result-order=ipv4first` — без этого `fetch` к внешним API
  виснет на AAAA-записях (в контейнере Timeweb нет маршрута IPv6).
- `HEALTHCHECK` вызывает `curl` **без** флага `-f`: любой HTTP-ответ = процесс
  жив. С `-f` контейнер считался бы битым при лежащей базе, и платформа
  откатывала бы исправный деплой.
- `/api/health` **всегда** отвечает `200`; реальное состояние — в теле (`ok`,
  `checks.database`).

### Режимы обслуживания

| Переменная | Эффект |
|---|---|
| `MAINTENANCE_MODE=1` | middleware отдаёт страницу техработ (503) на всё, кроме `/api/health`; миграции на старте пропускаются. Включается без пересборки. |
| `SKIP_MIGRATIONS=1` | не пытаться мигрировать на старте (база заведомо чинится руками). |

---

## Telegram-бот через Cloudflare Worker

Прямой `api.telegram.org` из Timeweb заблокирован, а прямая доставка вебхука
Telegram → РФ-хостинг ретраится минутами. Поэтому **весь трафик Telegram — в обе
стороны — идёт через Cloudflare Worker**.

1. **Бот.** @BotFather → новый бот (личный, не бот другого продукта) → токен в
   `TELEGRAM_BOT_TOKEN`.
2. **Свой chat_id.** @userinfobot → число в `TELEGRAM_OWNER_CHAT_ID`. Бот
   обслуживает только этот чат, остальным отвечает отказом.
3. **Worker.** Готовый скрипт и пошаговая инструкция — в
   `infra/cloudflare-worker/`. **Свой домен не нужен:** Cloudflare бесплатно
   выдаёт адрес `*.workers.dev`, и его достаточно. Worker делает две вещи:
   - проксирует исходящие вызовы `<адрес>/bot<token>/<method>` →
     `https://api.telegram.org/bot<token>/<method>`;
   - принимает вебхук Telegram и форвардит его на прод
     (`<APP_URL>/api/telegram/webhook`), сохраняя заголовок
     `X-Telegram-Bot-Api-Secret-Token`.
4. **Переменные:** `TELEGRAM_API_BASE` и `TELEGRAM_WEBHOOK_BASE` — адрес
   Worker'а, `TELEGRAM_WEBHOOK_SECRET` (`openssl rand -hex 32`).
5. **Установка вебхука:** `POST /api/telegram/setup` из-под сессии владельца
   (`GET` того же роута показывает текущее состояние вебхука).

Дедуп входящих — по `update_id` в таблице `WebhookDedup` (чистится джобой
`cleanup-dedup`). Исходящие: таймаут отправки **не** ретраится — сообщение
скорее всего доставлено, потерян только ответ, а слепой повтор дублирует
сообщение владельцу.

---

## Структура каталогов

```
business-os/
├── Dockerfile                    # 3 стадии: deps → build → runtime
├── scripts/
│   ├── start-container.mjs       # миграции → server.js → планировщик
│   ├── db-migrate-safe.mjs       # migrate deploy, устойчивый к блипу базы
│   └── hash-password.mjs         # генерация OWNER_PASSWORD_HASH
├── prisma/
│   ├── schema.prisma             # модель данных (деньги — Int в копейках)
│   └── migrations/               # 00000000000000_init_extensions — pgvector, pg_trgm
├── .github/workflows/ci.yml      # typecheck + тесты + build (+ образ на push в main)
└── src/
    ├── app/
    │   ├── (auth)/login/         # вход по паролю
    │   ├── api/health/           # liveness: всегда 200, состояние — в теле
    │   ├── api/cron/[job]/       # диспетчер задач по CRON_SECRET
    │   ├── api/auth/ api/telegram/
    │   └── globals.css           # токены тёмной темы
    ├── core/
    │   ├── db.ts env.ts          # Prisma-синглтон, доступ к окружению
    │   ├── auth/ llm/ telegram/  # сессия, каскад шлюзов, бот
    │   ├── cron/                 # registry.ts (реестр) + jobs.ts (обработчики)
    │   ├── observability/        # структурные логи `домен.факт`
    │   └── shared/               # деньги (копейки), время (Europe/Moscow), cn
    ├── components/os/            # KPI-карточки, панели
    └── middleware.ts             # техработы + сессия + публичные пути
```

---

## Конвенции

- **Деньги — всегда `Int` в копейках.** Никаких `Float`/`Decimal` для сумм.
- **Время в базе — UTC**, бизнес-периоды режутся по Europe/Moscow
  (`src/core/shared/time.ts`).
- **Логи структурные**, событие называется `домен.факт`
  (`cron.job_finished`, `llm.gateway_failed`); секреты маскируются логгером.
- **Каждый найденный баг → регрессионный тест.** Без теста баг не закрыт.
- **Прямой пуш в `main` запрещён**: ветка → зелёный CI → PR → мёрж (= деплой).
- Тесты кириллицы в чатах — из UI или python-клиентом, не `curl` из Git Bash
  (он шлёт CP1251, в базе получаются кракозябры).
