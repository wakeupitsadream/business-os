/**
 * Структурные логи одной строкой JSON — их читает панель Timeweb, и по ним
 * потом ищут причину инцидента. Правило: событие называется `<домен>.<факт>`
 * (llm.gateway_failed, telegram.send_slow), данные — плоский объект.
 *
 * Секреты в логи не попадают: значения полей с «подозрительными» именами
 * маскируются здесь, а не на стороне вызывающего — полагаться на дисциплину
 * десятков call-site нельзя.
 */

type LogLevel = "info" | "warn" | "error";
type LogData = Record<string, unknown>;

const SECRET_KEY = /token|secret|password|api[-_]?key|authorization|cookie/i;

function maskValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}***${value.slice(-2)}`;
}

export function sanitizeLogData(data: LogData): LogData {
  const out: LogData = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (SECRET_KEY.test(key)) {
      out[key] = maskValue(value);
    } else if (value instanceof Error) {
      out[key] = value.message;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function emit(level: LogLevel, event: string, data?: LogData): void {
  const line = JSON.stringify({
    level,
    event,
    ts: new Date().toISOString(),
    ...(data ? sanitizeLogData(data) : {}),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logInfo = (event: string, data?: LogData) => emit("info", event, data);
export const logWarn = (event: string, data?: LogData) => emit("warn", event, data);
export const logError = (event: string, data?: LogData) => emit("error", event, data);

/** Замер длительности операции для логов: `const done = startTimer(); … done()`. */
export function startTimer(): () => number {
  const t0 = Date.now();
  return () => Date.now() - t0;
}
