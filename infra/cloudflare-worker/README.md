# Cloudflare Worker — прокси Telegram

Один Worker обслуживает оба направления: исходящие вызовы Bot API из приложения
и входящие вебхуки от Telegram. Без него канал не работает — прямой
`api.telegram.org` из Timeweb заблокирован, а прямая доставка вебхуков на
российский хостинг ретраится минутами.

**Собственный домен не нужен.** Cloudflare бесплатно выдаёт каждому Worker'у
адрес вида `telegram-proxy.<аккаунт>.workers.dev` — его достаточно и для
исходящих вызовов, и для вебхука. Домен пригодится позже, если захочется
короткий адрес; на работу канала это не влияет.

## Развёртывание (через панель Cloudflare, ~10 минут)

1. **Worker.** Workers & Pages → Create → Worker. Назови `telegram-proxy`,
   нажми Deploy, затем Edit code — вставь содержимое `worker.js` целиком,
   сохрани и задеплой. Cloudflare покажет выданный адрес
   `https://telegram-proxy.<аккаунт>.workers.dev` — запиши его, это и есть
   адрес прокси.

2. **Переменная.** Settings → Variables and Secrets → Add:
   - `ORIGIN` = боевой адрес Business OS без слэша на конце. На старте это
     технический адрес приложения от Timeweb; когда появится свой домен —
     просто поменяй значение, передеплоивать Worker не нужно.

3. **Проверка прокси.** Подставь свой адрес Worker'а и токен бота:
   ```
   curl "https://telegram-proxy.<аккаунт>.workers.dev/bot<TOKEN>/getMe"
   ```
   Должен прийти JSON с `"ok":true` и данными бота. Если 502 — проверь, что
   Worker задеплоен и что `ORIGIN` задан.

   *(Необязательно, для короткого адреса: Settings → Domains & Routes → Add →
   Custom domain, например `tg.example.com`. Дальше просто используй его вместо
   `*.workers.dev` во всех переменных.)*

4. **Переменные приложения** (панель Timeweb):
   ```
   TELEGRAM_API_BASE=https://telegram-proxy.<аккаунт>.workers.dev
   TELEGRAM_WEBHOOK_BASE=https://telegram-proxy.<аккаунт>.workers.dev
   TELEGRAM_WEBHOOK_SECRET=<openssl rand -hex 32>
   TELEGRAM_BOT_TOKEN=<токен от @BotFather>
   TELEGRAM_OWNER_CHAT_ID=<свой chat_id от @userinfobot>
   ```

5. **Установка вебхука.** Войди в Business OS и вызови из браузерной консоли
   (или curl с сессионной кукой):
   ```
   fetch("/api/telegram/setup", { method: "POST" }).then(r => r.json()).then(console.log)
   ```
   Ответ Telegram должен содержать `"ok":true`. Проверить состояние —
   `GET /api/telegram/setup` (отдаёт `getWebhookInfo`).

6. **Живая проверка.** Напиши боту `/ping` — должен ответить «понг» и показать
   SHA сборки. Затем обычное сообщение — ответит модель.

## Диагностика

| Симптом | Где смотреть |
|---|---|
| `getMe` через прокси даёт 502 | Worker не задеплоен либо `ORIGIN` не задан |
| Вебхук не приходит | `GET /api/telegram/setup` → поле `last_error_message` |
| Бот молчит на сообщения | Логи Timeweb: `telegram.*`; проверь `TELEGRAM_OWNER_CHAT_ID` |
| Ответы приходят по 2 раза | Дедуп fail-open при недоступной БД — смотри `/api/health` |
| В логах `telegram.send_slow` | Прокси или сеть деградируют; посмотри аналитику Worker |

## Почему Worker отвечает 200, когда приложение недоступно

При передеплое контейнер несколько секунд не отвечает. Если вернуть Telegram
ошибку, он начнёт ретраить апдейт с растущими паузами, и после возврата прода
прилетит пачка дублей. Потерять одно сообщение во время деплоя дешевле —
владелец просто напишет ещё раз.
