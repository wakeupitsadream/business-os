# syntax=docker/dockerfile:1
# Business OS — прод-образ (Timeweb App Platform / любой Docker-хостинг).
# Next.js 15 standalone + Prisma CLI для миграций на старте + встроенный
# планировщик задач (системных кронов на хостинге нет).

# ---------- deps ----------
FROM node:22-alpine AS deps
WORKDIR /app
# prisma/ копируется до npm ci: в package.json есть postinstall `prisma generate`,
# без схемы установка упадёт.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Заглушки на время сборки: next build выполняет модули роутов, а реальных
# секретов на сборочной машине нет и быть не должно. К базе сборка не ходит —
# миграции применяются на старте контейнера.
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?sslmode=disable" \
    DIRECT_URL="postgresql://build:build@127.0.0.1:5432/build?sslmode=disable" \
    AUTH_SECRET="build-time-placeholder"
# SHA коммита сборки → BUILD_SHA → /api/health. Урок Agentus: два деплоя из
# очереди выкатились не по порядку, и час ушёл на выяснение, какой коммит
# реально обслуживает трафик. .git специально НЕ в .dockerignore.
RUN apk add --no-cache git && (git rev-parse HEAD 2>/dev/null || echo unknown) > .build-sha
# public/ может отсутствовать в репозитории — создаём заранее, иначе COPY
# в runtime-стадии свалит сборку.
RUN mkdir -p public
RUN npx prisma generate && npx next build

# ---------- runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
# Сигналы гасит наш код, а не рантайм Next: иначе SIGTERM обрывает начатые
# ответы агента мгновенно.
ENV NEXT_MANUAL_SIG_HANDLE=true
# Без этого fetch к внешним API (шлюзы LLM, Cloudflare Worker Telegram) виснет
# на AAAA-записях: IPv6-маршрута в контейнере Timeweb нет.
ENV NODE_OPTIONS="--dns-result-order=ipv4first"
RUN apk add --no-cache curl

# standalone-сервер + статика + public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/.build-sha ./.build-sha

# Схема и миграции + скрипты старта: db-migrate-safe гоняет `migrate deploy`
# при каждом запуске контейнера.
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts ./scripts
# Полный package.json кладём под другим именем: в /app уже лежит урезанный
# package.json от standalone, перезаписывать его нельзя.
COPY package.json ./package.json.app
RUN npm install --no-save --no-audit --no-fund prisma@6

EXPOSE 3000

# Liveness, НЕ readiness — и БЕЗ флага -f. С -f curl падает на любом 5xx
# (лежащая база, режим техработ) → healthcheck fail → хостинг отклоняет деплой
# и держит старый образ, хотя новый код исправен. Любой HTTP-ответ = процесс жив.
#
# Адрес именно /api/health/live, а НЕ /api/health: второй ходит в базу, а проба
# идёт каждые 30 секунд — 2880 запросов в сутки. Компьют Neon от такого не
# засыпает никогда и выбирает месячный лимит бесплатного тарифа за две с
# половиной недели. Есть тест, который следит, чтобы адрес не уехал обратно.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -sS -o /dev/null http://127.0.0.1:3000/api/health/live || exit 1

CMD ["node", "scripts/start-container.mjs"]
