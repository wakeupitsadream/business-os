import { describe, expect, it } from "vitest";
import { buildChatBody, parseChatResponse, type LlmChatOptions } from "./chat";

/**
 * Тесты чистых частей чат-вызова: сборка тела запроса и разбор ответа.
 * Сети и БД тут нет — каскад проверяется на проде метриками LlmUsage.
 */

const baseOpts: LlmChatOptions = {
  feature: "test",
  messages: [{ role: "user", content: "привет" }],
};

describe("buildChatBody", () => {
  it("не шлёт temperature и max_tokens, если их не задали", () => {
    const body = buildChatBody("gpt-4o-mini", baseOpts);
    expect(body["model"]).toBe("gpt-4o-mini");
    expect("temperature" in body).toBe(false);
    expect("max_tokens" in body).toBe(false);
    expect("tools" in body).toBe(false);
  });

  it("передаёт temperature 0 (а не считает его отсутствующим)", () => {
    const body = buildChatBody("m", { ...baseOpts, temperature: 0 });
    expect(body["temperature"]).toBe(0);
  });

  it("оборачивает инструменты в OpenAI-формат и включает tool_choice", () => {
    const body = buildChatBody("m", {
      ...baseOpts,
      tools: [{ name: "create_task", description: "создать задачу", parameters: { type: "object" } }],
    });
    expect(body["tool_choice"]).toBe("auto");
    expect(body["tools"]).toEqual([
      {
        type: "function",
        function: { name: "create_task", description: "создать задачу", parameters: { type: "object" } },
      },
    ]);
  });

  it("сообщение роли tool несёт tool_call_id", () => {
    const body = buildChatBody("m", {
      ...baseOpts,
      messages: [
        { role: "user", content: "сделай" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1" }] },
        { role: "tool", content: "{\"ok\":true}", tool_call_id: "c1", name: "create_task" },
      ],
    });
    const messages = body["messages"] as Array<Record<string, unknown>>;
    expect(messages[1]?.["tool_calls"]).toEqual([{ id: "c1" }]);
    expect(messages[2]?.["tool_call_id"]).toBe("c1");
    expect(messages[2]?.["name"]).toBe("create_task");
  });

  it("на не-tool сообщениях tool_call_id не появляется", () => {
    const body = buildChatBody("m", baseOpts);
    const messages = body["messages"] as Array<Record<string, unknown>>;
    expect(messages[0] && "tool_call_id" in messages[0]).toBe(false);
  });
});

describe("parseChatResponse", () => {
  it("разбирает обычный текстовый ответ с расходом токенов", () => {
    const parsed = parseChatResponse({
      choices: [{ message: { role: "assistant", content: "  готово  " } }],
      usage: { prompt_tokens: 120, completion_tokens: 8 },
    });
    expect(parsed).toEqual({ text: "готово", toolCalls: [], inputTokens: 120, outputTokens: 8 });
  });

  it("разбирает content массивом частей", () => {
    const parsed = parseChatResponse({
      choices: [{ message: { content: [{ type: "text", text: "часть 1 " }, { type: "text", text: "часть 2" }] } }],
    });
    expect(parsed?.text).toBe("часть 1 часть 2");
  });

  it("разбирает tool_calls при пустом тексте", () => {
    const parsed = parseChatResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "create_task", arguments: "{\"title\":\"x\"}" } },
            ],
          },
        },
      ],
    });
    expect(parsed?.text).toBe("");
    expect(parsed?.toolCalls).toEqual([{ id: "call_1", name: "create_task", arguments: "{\"title\":\"x\"}" }]);
  });

  it("аргументы объектом сериализуются в строку", () => {
    const parsed = parseChatResponse({
      choices: [{ message: { tool_calls: [{ id: "c", function: { name: "f", arguments: { a: 1 } } }] } }],
    });
    expect(parsed?.toolCalls[0]?.arguments).toBe("{\"a\":1}");
  });

  it("вызов без имени инструмента отбрасывается", () => {
    const parsed = parseChatResponse({
      choices: [{ message: { content: "текст", tool_calls: [{ id: "c", function: {} }] } }],
    });
    expect(parsed?.toolCalls).toEqual([]);
  });

  it("отсутствие токенов в ответе не роняет разбор", () => {
    const parsed = parseChatResponse({ choices: [{ message: { content: "ок" } }] });
    expect(parsed?.inputTokens).toBe(0);
    expect(parsed?.outputTokens).toBe(0);
  });

  for (const [name, payload] of [
    ["не объект", "заглушка балансировщика"],
    ["нет choices", { usage: {} }],
    ["choices пуст", { choices: [] }],
    ["нет message", { choices: [{ finish_reason: "stop" }] }],
    ["пустой ответ без инструментов", { choices: [{ message: { content: "   " } }] }],
  ] as const) {
    it(`считает провалом шлюза: ${name}`, () => {
      expect(parseChatResponse(payload)).toBeNull();
    });
  }
});
