/**
 * Ограничение попыток входа: 5 за 15 минут на IP.
 *
 * Хранилище — Map в памяти процесса. Redis тут не нужен и вреден: контейнер
 * один, перезапуск сбрасывает счётчики (это приемлемо — атака переживёт разве
 * что деплой), а лишняя внешняя зависимость означала бы, что её недоступность
 * ломает вход владельцу.
 */

import { envInt } from "@/core/env";

export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export interface RateLimitResult {
  allowed: boolean;
  /** Сколько попыток осталось в текущем окне. */
  remaining: number;
  /** Секунды до разблокировки; 0, когда попытка разрешена. */
  retryAfterSec: number;
}

/** Метки времени попыток по каждому IP, всегда отсортированы по возрастанию. */
const attempts = new Map<string, number[]>();

/**
 * Полная уборка карты запускается не чаще раза в окно: пробегать все ключи на
 * каждый запрос незачем, а без уборки Map растёт от сканеров, перебирающих
 * /api/auth/login с тысяч адресов.
 */
let lastSweepAt = 0;

function sweep(now: number): void {
  if (now - lastSweepAt < LOGIN_WINDOW_MS) return;
  lastSweepAt = now;
  for (const [ip, stamps] of attempts) {
    if (stamps.length === 0 || (stamps[stamps.length - 1] ?? 0) <= now - LOGIN_WINDOW_MS) {
      attempts.delete(ip);
    }
  }
}

function fresh(ip: string, now: number): number[] {
  const cutoff = now - LOGIN_WINDOW_MS;
  const kept = (attempts.get(ip) ?? []).filter((t) => t > cutoff);
  if (kept.length === 0) attempts.delete(ip);
  else attempts.set(ip, kept);
  return kept;
}

/**
 * Регистрирует попытку входа и говорит, разрешена ли она.
 * Вызывать ДО проверки пароля: считаем именно попытки, а не только неудачи,
 * иначе перебор с параллельными запросами проскакивает мимо лимита.
 */
export function hitLoginAttempt(ip: string, now: number = Date.now()): RateLimitResult {
  sweep(now);
  const stamps = fresh(ip, now);

  if (stamps.length >= LOGIN_MAX_ATTEMPTS) {
    const oldest = stamps[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + LOGIN_WINDOW_MS - now) / 1000));
    return { allowed: false, remaining: 0, retryAfterSec };
  }

  stamps.push(now);
  attempts.set(ip, stamps);
  return { allowed: true, remaining: LOGIN_MAX_ATTEMPTS - stamps.length, retryAfterSec: 0 };
}

/** Успешный вход обнуляет счётчик — владелец не должен ловить лимит после опечаток. */
export function resetLoginAttempts(ip: string): void {
  attempts.delete(ip);
}

/** Только для тестов: полный сброс хранилища. */
export function resetLoginRateLimitStore(): void {
  attempts.clear();
  lastSweepAt = 0;
}

/**
 * Сколько доверенных прокси стоит перед приложением. На Timeweb App Platform —
 * один. Переопределяется переменной TRUSTED_PROXY_HOPS, если контур изменится
 * (например, добавится Cloudflare перед хостингом).
 */
function trustedProxyHops(): number {
  return Math.max(1, envInt("TRUSTED_PROXY_HOPS", 1));
}

/**
 * IP клиента из цепочки x-forwarded-for.
 *
 * Заголовок выглядит как «клиент, прокси1, прокси2» и дописывается СПРАВА:
 * каждый прокси добавляет адрес того, от кого получил запрос. Отсюда главное:
 * левые элементы пишет сам клиент, и доверять им нельзя. Раньше здесь брался
 * первый элемент — то есть значение, которое атакующий задаёт сам, — и лимит
 * попыток входа обходился одним заголовком: меняешь X-Forwarded-For на каждый
 * запрос и перебираешь пароль владельца без ограничений.
 *
 * Правильный адрес — тот, который дописал наш собственный прокси, то есть
 * отсчитанный от ПРАВОГО конца на число доверенных прокси.
 */
export function clientIp(headers: Headers): string {
  const chain = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (chain.length > 0) {
    // Цепочка короче ожидаемой — запрос пришёл мимо привычного контура.
    // Берём самый правый элемент: он в любом случае наименее подделываемый.
    const index = Math.max(0, chain.length - trustedProxyHops());
    const ip = chain[index];
    if (ip) return ip;
  }

  return headers.get("x-real-ip")?.trim() || "unknown";
}

/** Русское сообщение о превышении лимита. */
export function rateLimitMessage(retryAfterSec: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  return `Слишком много попыток, попробуйте через ${minutes} ${pluralMinutes(minutes)}`;
}

function pluralMinutes(n: number): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return "минут";
  if (mod10 === 1) return "минуту";
  if (mod10 >= 2 && mod10 <= 4) return "минуты";
  return "минут";
}
