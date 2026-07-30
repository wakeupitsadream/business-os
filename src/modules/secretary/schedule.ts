import { TZDate } from "@date-fns/tz";
import type { RepeatPreset } from "@prisma/client";
import { OWNER_TZ } from "@/core/shared/time";

/**
 * Расчёт следующего срабатывания повторяющегося напоминания.
 *
 * Считается в часовом поясе владельца, а не в UTC. Разница не теоретическая:
 * ежедневное напоминание на 09:00 МСК, посчитанное прибавлением 24 часов к
 * UTC-метке, останется на 09:00 только до ближайшего перевода часов в любой
 * задействованной зоне. В Москве переводов нет, но зона владельца хранится в
 * настройках и однажды окажется другой — а такой сдвиг замечают не сразу и
 * долго не могут объяснить.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Страховка от бесконечного цикла; после перескока хватает единиц шагов. */
const MAX_STEPS = 400;

export function nextFireAt(
  preset: RepeatPreset,
  previous: Date,
  tz: string = OWNER_TZ,
  now: Date = new Date(),
): Date {
  // Отталкиваемся от прошлого срабатывания, а не от «сейчас»: иначе
  // напоминание, доставленное с опозданием (контейнер перезапускался),
  // сдвигает всю дальнейшую серию.
  let candidate = advance(preset, previous, tz);
  if (candidate.getTime() > now.getTime()) return candidate;

  // Система стояла долго. Шагать по одному интервалу через сотни дней —
  // это сотни итераций, и раньше ограничитель успевал сработать до того, как
  // дата догоняла настоящее: функция возвращала ПРОШЕДШЕЕ время. Такое
  // напоминание срабатывает немедленно, тут же пересчитывается в прошлое
  // снова — и превращается в поток уведомлений владельцу.
  // Поэтому сначала перескакиваем целыми интервалами, сохраняя фазу серии
  // (число месяца для MONTHLY, день недели для WEEKLY), и лишь потом дошагиваем.
  candidate = fastForward(preset, candidate, tz, now);

  let steps = 0;
  while (candidate.getTime() <= now.getTime() && steps++ < MAX_STEPS) {
    candidate = advance(preset, candidate, tz);
  }

  // Инвариант важнее сохранения фазы: результат обязан быть в будущем.
  return candidate.getTime() > now.getTime() ? candidate : advance(preset, now, tz);
}

/** Перескок целыми интервалами вплотную к настоящему, без потери фазы. */
function fastForward(preset: RepeatPreset, from: Date, tz: string, now: Date): Date {
  const gapDays = Math.floor((now.getTime() - from.getTime()) / DAY_MS);
  if (gapDays <= 0) return from;

  const local = new TZDate(from, tz);
  const y = local.getFullYear();
  const m = local.getMonth();
  const d = local.getDate();
  const h = local.getHours();
  const min = local.getMinutes();

  switch (preset) {
    case "DAILY":
      return toUtc(new TZDate(y, m, d + gapDays, h, min, 0, 0, tz));

    // Кратность семи сохраняет день недели — и для еженедельного напоминания,
    // и для будничного (там останется дошагать максимум пару дней).
    case "WEEKLY":
    case "WEEKDAYS":
      return toUtc(new TZDate(y, m, d + Math.floor(gapDays / 7) * 7, h, min, 0, 0, tz));

    case "MONTHLY": {
      const nowLocal = new TZDate(now, tz);
      const months =
        (nowLocal.getFullYear() - y) * 12 + (nowLocal.getMonth() - m);
      if (months <= 0) return from;
      const lastDay = daysInMonth(y, m + months, tz);
      return toUtc(new TZDate(y, m + months, Math.min(d, lastDay), h, min, 0, 0, tz));
    }
  }
}

function advance(preset: RepeatPreset, from: Date, tz: string): Date {
  const local = new TZDate(from, tz);
  const y = local.getFullYear();
  const m = local.getMonth();
  const d = local.getDate();
  const h = local.getHours();
  const min = local.getMinutes();

  switch (preset) {
    case "DAILY":
      return toUtc(new TZDate(y, m, d + 1, h, min, 0, 0, tz));

    case "WEEKDAYS": {
      // Пропускаем субботу и воскресенье: напоминание «созвон с командой»
      // в выходной — это не полезность, а шум, который учит игнорировать бота.
      let step = 1;
      for (let i = 0; i < 7; i++) {
        const probe = new TZDate(y, m, d + step, h, min, 0, 0, tz);
        const weekday = probe.getDay();
        if (weekday !== 0 && weekday !== 6) return toUtc(probe);
        step += 1;
      }
      return toUtc(new TZDate(y, m, d + 1, h, min, 0, 0, tz));
    }

    case "WEEKLY":
      return toUtc(new TZDate(y, m, d + 7, h, min, 0, 0, tz));

    case "MONTHLY": {
      // 31-е число в коротком месяце: JS сам перекатывает на следующий месяц
      // (31 февраля → 3 марта), из-за чего «последний день месяца» уезжает.
      // Прижимаем к последнему существующему дню.
      const targetMonth = m + 1;
      const lastDay = daysInMonth(y, targetMonth, tz);
      return toUtc(new TZDate(y, targetMonth, Math.min(d, lastDay), h, min, 0, 0, tz));
    }
  }
}

function daysInMonth(year: number, month: number, tz: string): number {
  // Нулевой день следующего месяца = последний день текущего.
  return new TZDate(year, month + 1, 0, 12, 0, 0, 0, tz).getDate();
}

function toUtc(d: TZDate): Date {
  return new Date(d.getTime());
}

/** Человекочитаемое описание повтора — для подтверждений владельцу. */
export function describeRepeat(preset: RepeatPreset | null | undefined): string {
  switch (preset) {
    case "DAILY":
      return "каждый день";
    case "WEEKDAYS":
      return "по будням";
    case "WEEKLY":
      return "каждую неделю";
    case "MONTHLY":
      return "каждый месяц";
    default:
      return "один раз";
  }
}
