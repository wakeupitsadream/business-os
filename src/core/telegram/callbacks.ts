/**
 * Разбор данных inline-кнопок Telegram.
 *
 * Формат `домен:действие:значение` — короткий намеренно: Telegram ограничивает
 * `callback_data` 64 байтами, и в кириллице этот лимит кончается неожиданно
 * быстро. Поэтому в кнопках только латинские ключи и идентификаторы.
 */

export type CallbackAction =
  | { kind: "checkin"; field: "mood" | "energy"; value: number }
  | { kind: "checkin_skip" }
  | { kind: "reminder_done"; reminderId: string }
  | { kind: "reminder_snooze"; reminderId: string; hours: number }
  | { kind: "task_done"; taskId: string }
  | { kind: "approval"; notificationId: string; approved: boolean }
  | { kind: "import_confirm"; batchId: string; fingerprintPrefix: string }
  | { kind: "import_cancel"; batchId: string }
  | { kind: "unknown"; raw: string };

export const CALLBACK_DATA_LIMIT = 64;

export function parseCallbackData(raw: string | undefined): CallbackAction {
  const data = (raw ?? "").trim();
  if (data.length === 0) return { kind: "unknown", raw: "" };

  const [domain, action, value, extra] = data.split(":");

  if (domain === "imp" && value) {
    // Отпечаток едет коротким префиксом: полные 64 символа не влезают в лимит
    // callback_data вместе с идентификатором партии.
    if (action === "ok" && extra) {
      return { kind: "import_confirm", batchId: value, fingerprintPrefix: extra };
    }
    if (action === "no") return { kind: "import_cancel", batchId: value };
  }

  if (domain === "ci") {
    if (action === "skip") return { kind: "checkin_skip" };
    if ((action === "mood" || action === "energy") && value) {
      const n = Number.parseInt(value, 10);
      // Шкала 1–5 зашита в модели; значение вне её означает подделку или
      // рассинхрон версий — молча принимать такое нельзя.
      if (Number.isInteger(n) && n >= 1 && n <= 5) {
        return { kind: "checkin", field: action, value: n };
      }
    }
    return { kind: "unknown", raw: data };
  }

  if (domain === "rem" && value) {
    if (action === "done") return { kind: "reminder_done", reminderId: value };
    if (action === "s1") return { kind: "reminder_snooze", reminderId: value, hours: 1 };
    if (action === "s24") return { kind: "reminder_snooze", reminderId: value, hours: 24 };
    return { kind: "unknown", raw: data };
  }

  if (domain === "task" && action === "done" && value) {
    return { kind: "task_done", taskId: value };
  }

  if (domain === "ap" && value && (action === "yes" || action === "no")) {
    return { kind: "approval", notificationId: value, approved: action === "yes" };
  }

  return { kind: "unknown", raw: data };
}

/** Сборка `callback_data` с проверкой лимита Telegram. */
export function buildCallbackData(parts: string[]): string {
  const data = parts.join(":");
  if (Buffer.byteLength(data, "utf8") > CALLBACK_DATA_LIMIT) {
    // Telegram отвергнет всю клавиатуру целиком, и владелец получит сообщение
    // без кнопок вообще — без внятного объяснения, что произошло.
    throw new Error(`callback_data длиннее ${CALLBACK_DATA_LIMIT} байт: ${data}`);
  }
  return data;
}

/** Клавиатура оценки по шкале 1–5. */
export function scaleKeyboard(field: "mood" | "energy"): Array<
  Array<{ text: string; callbackData: string }>
> {
  return [
    [1, 2, 3, 4, 5].map((n) => ({
      text: String(n),
      callbackData: buildCallbackData(["ci", field, String(n)]),
    })),
    [{ text: "Пропустить", callbackData: buildCallbackData(["ci", "skip"]) }],
  ];
}

/**
 * Кнопки под запросом подтверждения опасного действия.
 *
 * id уведомления — cuid (~25 символов), с префиксом «ap:yes:» укладывается в
 * лимит callback_data с запасом.
 */
export function approvalKeyboard(notificationId: string): Array<
  Array<{ text: string; callbackData: string }>
> {
  return [
    [
      { text: "✅ Выполнить", callbackData: buildCallbackData(["ap", "yes", notificationId]) },
      { text: "✖️ Отклонить", callbackData: buildCallbackData(["ap", "no", notificationId]) },
    ],
  ];
}

/** Кнопки под напоминанием. */
export function reminderKeyboard(reminderId: string): Array<
  Array<{ text: string; callbackData: string }>
> {
  return [
    [
      { text: "Готово", callbackData: buildCallbackData(["rem", "done", reminderId]) },
      { text: "Через час", callbackData: buildCallbackData(["rem", "s1", reminderId]) },
      { text: "Завтра", callbackData: buildCallbackData(["rem", "s24", reminderId]) },
    ],
  ];
}
