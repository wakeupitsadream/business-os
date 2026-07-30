import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRegistry, maskArgs, parseToolArgs, toJsonSchema } from "./tool-registry";
import type { AgentTool } from "./types";

function tool(name: string, schema: z.ZodType = z.object({})): AgentTool {
  return {
    name,
    description: `инструмент ${name}`,
    schema,
    async execute() {
      return { ok: true, message: "готово" };
    },
  };
}

describe("ToolRegistry", () => {
  it("отдаёт описания для модели", () => {
    const r = new ToolRegistry().registerAll([tool("a"), tool("b")]);
    expect(r.names()).toEqual(["a", "b"]);
    expect(r.definitions().map((d) => d.name)).toEqual(["a", "b"]);
  });

  it("не даёт молча перезаписать инструмент", () => {
    // Два модуля с одинаковым именем инструмента — работал бы тот, что
    // зарегистрировался последним, и понять это в проде почти невозможно.
    const r = new ToolRegistry().register(tool("create_task"));
    expect(() => r.register(tool("create_task"))).toThrow(/уже зарегистрирован/);
  });

  it("ищет только среди своих ключей", () => {
    // Имя приходит из ответа модели: обращение к объекту напрямую вернуло бы
    // функцию из прототипа.
    const r = new ToolRegistry().register(tool("a"));
    expect(r.get("constructor")).toBeUndefined();
    expect(r.get("toString")).toBeUndefined();
    expect(r.get("a")).toBeDefined();
  });
});

describe("toJsonSchema", () => {
  it("превращает схему в объектную JSON Schema", () => {
    const json = toJsonSchema(
      z.object({ title: z.string(), priority: z.number().optional() }),
    );
    expect(json.type).toBe("object");
    expect(Object.keys(json.properties as object)).toEqual(["title", "priority"]);
  });

  it("поле со значением по умолчанию не объявляется обязательным", () => {
    // Иначе модель считает, что обязана его прислать, и придумывает значение
    // вместо того, чтобы положиться на дефолт.
    const json = toJsonSchema(z.object({ text: z.string(), module: z.string().default("personal") }));
    expect(json.required).toEqual(["text"]);
  });

  it("схема без полей всё равно остаётся объектом", () => {
    const json = toJsonSchema(z.object({}));
    expect(json.type).toBe("object");
  });
});

describe("parseToolArgs", () => {
  const schema = z.object({ title: z.string().min(1), priority: z.number().int().default(2) });

  it("разбирает корректные аргументы", () => {
    const r = parseToolArgs(schema, '{"title":"позвонить в банк"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ title: "позвонить в банк", priority: 2 });
  });

  it("пустая строка означает вызов без аргументов", () => {
    const r = parseToolArgs(z.object({ q: z.string().optional() }), "");
    expect(r.ok).toBe(true);
  });

  it("битый JSON не роняет вызов", () => {
    const r = parseToolArgs(schema, "{title: неверно}");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/JSON/);
  });

  it("ошибка перечисляет поля, чтобы модель могла исправиться", () => {
    const r = parseToolArgs(schema, '{"priority":"высокий"}');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("title");
      expect(r.error).toContain("priority");
    }
  });

  it("отсекает лишнее вместо того, чтобы падать глубже", () => {
    const r = parseToolArgs(schema, '{"title":"дело","выдуманное":"поле"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).not.toHaveProperty("выдуманное");
  });
});

describe("maskArgs", () => {
  it("скрывает помеченные поля", () => {
    expect(maskArgs({ text: "личное", id: "1" }, ["text"])).toEqual({ text: "***", id: "1" });
  });

  it("без списка не трогает ничего", () => {
    expect(maskArgs({ a: 1 }, undefined)).toEqual({ a: 1 });
  });
});
