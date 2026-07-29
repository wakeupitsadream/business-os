# Cloudflare Worker — прокси Telegram

Один Worker обслуживает оба направления: исходящие вызовы Bot API из приложения
и входящие вебхуки от Telegram. Без него канал не работает — прямой
`api.telegram.org` из Timeweb заблокирован, а прямая доставка вебхуков на
российский хостинг ретраится минутами.

## Развёртывание (через панель Cloudflare, ~10 минут)

1. **Домен.** Нужен домен в Cloudflare. Заведи поддомен для прокси, например
   `tg.example.com` (можно тот же домен, что у приложения).

2. **Worker.** Workers & Pages → Create → Worker. Назови `telegram-proxy`,
   нажми Deploy, затем Edit code — вставь содержимое `worker.js` целиком,
   сохрани и задеплой.

3. **Переменная.** Settings → Variables and Secrets → Add:
   - `ORIGIN` = `https://os.example.com` (боевой адрес Business OS, без слэша).

4. **Маршрут.** Settings → Domains & Routes → Add → Custom domain →
   `tg.example.com`. Дождись выпуска сертификата (обычно минута).

5. **Проверка прокси.** Подставь свой токен:
   ```
   curl "https://tg.example.com/bot<TOKEN>/getMe"
   ```
   Должен прийти JSON с `"ok":true` и данными бота. Если 502 — проверь, что
   Worker задеплоен и маршрут привязан.

6. **Переменные приложения** (панель Timeweb):
   ```
   TELEGRAM_API_BASE=https://tg.example.com
   TELEGRAM_WEBHOOK_BASE=https://tg.example.com
   TELEGRAM_WEBHOOK_SECRET=<openssl rand -hex 32>
   TELEGRAM_BOT_TOKEN=<токен от @BotFather>
   TELEGRAM_OWNER_CHAT_ID=<свой chat_id от @userinfobot>
   ```

7. **Установка вебхука.** Войди в Business OS и вызови из браузерной консоли
   (или curl с сессионной кукой):
   ```
   fetch("/api/telegram/setup", { method: "POST" }).then(r => r.json()).then(console.log)
   ```
   Ответ Telegram должен содержать `"ok":true`. Проверить состояние —
   `GET /api/telegram/setup` (отдаёт `getWebhookInfo`).

8. **Живая проверка.** Напиши боту `/ping` — должен ответить «понг» и показать
   SHA сборки. Затем обычное сообщение — ответит модель.

## Диагностика

| Симптом | Где смотреть |
|---|---|
| `getMe` через прокси даёт 502 | Worker не задеплоен или маршрут не привязан |
| Вебхук не приходит | `GET /api/telegram/setup` → поле `last_error_message` |
| Бот молчит на сообщения | Логи Timeweb: `telegram.*`; проверь `TELEGRAM_OWNER_CHAT_ID` |
| Ответы приходят по 2 раза | Дедуп fail-open при недоступной БД — смотри `/api/health` |
| В логах `telegram.send_slow` | Прокси или сеть деградируют; посмотри аналитику Worker |

## Почему Worker отвечает 200, когда приложение недоступно

При передеплое контейнер несколько секунд не отвечает. Если вернуть Telegram
ошибку, он начнёт ретраить апдейт с растущими паузами, и после возврата прода
прилетит пачка дублей. Потерять одно сообщение во время деплоя дешевле —
владелец просто напишет ещё раз.
