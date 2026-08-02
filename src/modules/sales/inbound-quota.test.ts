import { beforeEach, describe, expect, it } from "vitest";
import {
  INBOUND_MAX_PER_WINDOW,
  INBOUND_WINDOW_MS,
  hitInboundQuota,
  resetInboundQuota,
} from "./inbound-quota";

/**
 * Лимит приёма заявок.
 *
 * Порог заведомо выше любого правдоподобного дня: настоящую заявку терять
 * нельзя, а ограничение защищает не от «на одну больше», а от заливки после
 * утечки секрета — он живёт в чужом приложении и в его логах.
 */

const NOW = Date.now();

beforeEach(() => {
  resetInboundQuota();
});

describe("обычный день проходит целиком", () => {
  it("десяток заявок подряд не упирается в лимит", () => {
    for (let i = 0; i < 10; i += 1) {
      expect(hitInboundQuota("1.2.3.4", NOW + i * 1000).allowed).toBe(true);
    }
  });
});

describe("заливка упирается", () => {
  it("после потолка отвечаем отказом со сроком", () => {
    for (let i = 0; i < INBOUND_MAX_PER_WINDOW; i += 1) {
      expect(hitInboundQuota("9.9.9.9", NOW).allowed).toBe(true);
    }

    const blocked = hitInboundQuota("9.9.9.9", NOW);
    expect(blocked.allowed).toBe(false);
    // Срок нужен: Agentus обязан знать, когда повторить, а не долбиться.
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("отказ не съедает окно навсегда", () => {
    for (let i = 0; i < INBOUND_MAX_PER_WINDOW; i += 1) hitInboundQuota("9.9.9.9", NOW);
    expect(hitInboundQuota("9.9.9.9", NOW).allowed).toBe(false);

    // Окно проехало — приём открыт снова.
    expect(hitInboundQuota("9.9.9.9", NOW + INBOUND_WINDOW_MS + 1).allowed).toBe(true);
  });

  it("один шумный адрес не блокирует остальные", () => {
    for (let i = 0; i < INBOUND_MAX_PER_WINDOW; i += 1) hitInboundQuota("9.9.9.9", NOW);

    expect(hitInboundQuota("9.9.9.9", NOW).allowed).toBe(false);
    expect(hitInboundQuota("5.5.5.5", NOW).allowed).toBe(true);
  });
});
