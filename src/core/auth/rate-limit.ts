/**
 * Ограничение попыток входа: 5 за 15 минут на IP.
 *
 * Хранилище — Map в памяти процесса. Redis тут не нужен и вреден: контейнер
 * один, перезапуск сбрасывает счётчики (это приемлемо — атака переживёт разве
 * что деплой), а лишняя внешняя зависимость означала бы, что её недоступность
 * ломает вход владельцу.
 */

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
 * IP клиента. За обратным прокси Timeweb реальный адрес приходит первым в
 * x-forwarded-for; socket-адрес там всегда адрес прокси и лимит был бы общим
 * на весь мир.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first;
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
