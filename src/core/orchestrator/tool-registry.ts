import { z } from "zod";
import type { LlmToolDef } from "@/core/llm";
import type { AgentTool } from "./types";

/**
 * Реестр инструментов агента.
 *
 * Отдельный объект, а не массив в коде цикла: модули («Секретарь», «Финансы»,
 * «Продажи») регистрируют свои инструменты сами, и цикл ничего о них не знает.
 * Добавление отдела не должно требовать правок в ядре.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  register(tool: AgentTool): this {
    if (this.tools.has(tool.name)) {
      // Молчаливая перезапись означала бы, что два модуля объявили инструмент
      // с одним именем, и работает случайный — тот, что зарегистрировался
      // последним. Такое лучше увидеть при старте, чем в проде.
      throw new Error(`Инструмент «${tool.name}» уже зарегистрирован`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: AgentTool[]): this {
    for (const t of tools) this.register(t);
    return this;
  }

  /** Поиск по имени из ответа модели — только среди собственных ключей. */
  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Описания для запроса к модели. */
  definitions(): LlmToolDef[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: toJsonSchema(t.schema),
    }));
  }
}

/**
 * Zod-схема → JSON Schema для поля `parameters` в описании инструмента.
 *
 * Берём встроенный в Zod 4 конвертер: держать свой — значит расходиться с
 * реальной схемой ровно тогда, когда кто-то использует не покрытый конструкцией
 * тип, и молча отправлять модели неверное описание.
 *
 * `io: "input"` важно: модель заполняет ВХОД схемы, а у полей с `.default()`
 * вход и выход различаются — в выходной версии такое поле обязательно, и
 * модель начинает считать, что обязана его прислать.
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input", target: "draft-7" }) as Record<
    string,
    unknown
  >;

  // Провайдеры ожидают объект на верхнем уровне: инструмент без аргументов
  // должен объявлять пустой объект, а не отсутствие типа.
  if (json.type !== "object") {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  return json;
}

/** Разбор аргументов инструмента с понятной для модели ошибкой. */
export function parseToolArgs<S extends z.ZodType>(
  schema: S,
  raw: string,
): { ok: true; value: z.infer<S> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    // Пустая строка — законный случай: так провайдеры передают вызов
    // инструмента без аргументов.
    parsed = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch {
    return { ok: false, error: "аргументы не являются корректным JSON" };
  }

  const result = schema.safeParse(parsed);
  if (result.success) return { ok: true, value: result.data };

  // Текст ошибки уходит обратно модели как результат вызова — по нему она
  // должна суметь исправиться со второй попытки, поэтому перечисляем поля.
  const issues = result.error.issues
    .map((i) => `${i.path.join(".") || "(корень)"}: ${i.message}`)
    .join("; ");
  return { ok: false, error: `аргументы не прошли проверку — ${issues}` };
}

/** Маскировка чувствительных полей перед записью в журнал действий. */
export function maskArgs(
  args: unknown,
  sensitive: string[] | undefined,
): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { value: args };
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const key of sensitive ?? []) {
    if (key in out) out[key] = "***";
  }
  return out;
}
