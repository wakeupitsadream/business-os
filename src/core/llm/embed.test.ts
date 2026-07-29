import { describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSIONS, parseEmbeddingResponse } from "./embed";

function vector(fill = 0.1): number[] {
  return new Array<number>(EMBEDDING_DIMENSIONS).fill(fill);
}

describe("parseEmbeddingResponse", () => {
  it("возвращает векторы в порядке входов, а не ответа", () => {
    const parsed = parseEmbeddingResponse(
      {
        data: [
          { index: 1, embedding: vector(0.2) },
          { index: 0, embedding: vector(0.1) },
        ],
        usage: { prompt_tokens: 42 },
      },
      2,
    );
    expect(parsed?.vectors[0]?.[0]).toBe(0.1);
    expect(parsed?.vectors[1]?.[0]).toBe(0.2);
    expect(parsed?.inputTokens).toBe(42);
  });

  it("без поля index порядок берётся из массива", () => {
    const parsed = parseEmbeddingResponse({ data: [{ embedding: vector(0.5) }] }, 1);
    expect(parsed?.vectors).toHaveLength(1);
  });

  it("неверная размерность — провал шлюза (колонка в БД vector(1536))", () => {
    const parsed = parseEmbeddingResponse({ data: [{ index: 0, embedding: [0.1, 0.2] }] }, 1);
    expect(parsed).toBeNull();
  });

  it("нечисловые значения в векторе — провал", () => {
    const broken = vector();
    broken[5] = Number.NaN;
    expect(parseEmbeddingResponse({ data: [{ index: 0, embedding: broken }] }, 1)).toBeNull();
  });

  it("несовпадение числа векторов и входов — провал", () => {
    expect(parseEmbeddingResponse({ data: [{ index: 0, embedding: vector() }] }, 2)).toBeNull();
  });

  it("повторяющийся index — провал (иначе вектор молча уехал бы не к тому тексту)", () => {
    const parsed = parseEmbeddingResponse(
      {
        data: [
          { index: 0, embedding: vector(0.1) },
          { index: 0, embedding: vector(0.2) },
        ],
      },
      2,
    );
    expect(parsed).toBeNull();
  });

  it("index вне диапазона — провал", () => {
    expect(parseEmbeddingResponse({ data: [{ index: 7, embedding: vector() }] }, 1)).toBeNull();
  });

  it("ответ не той формы — провал", () => {
    expect(parseEmbeddingResponse("<html>502</html>", 1)).toBeNull();
    expect(parseEmbeddingResponse({ data: {} }, 1)).toBeNull();
  });

  it("отсутствие usage не роняет разбор", () => {
    const parsed = parseEmbeddingResponse({ data: [{ index: 0, embedding: vector() }] }, 1);
    expect(parsed?.inputTokens).toBe(0);
  });
});
