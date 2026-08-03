import { describe, expect, it } from "vitest";
import { weekKey } from "@/core/shared/time";

describe("ключ ISO-недели", () => {
  it("неделя принадлежит году своего четверга", () => {
    // 29.12.2025 — понедельник, четверг этой недели уже 01.01.2026.
    expect(weekKey(new Date("2025-12-29T06:00:00Z"))).toBe("2026-W01");
    // 01.01.2027 — пятница, её четверг 31.12.2026.
    expect(weekKey(new Date("2027-01-01T06:00:00Z"))).toBe("2026-W53");
  });

  it("воскресенье остаётся в своей неделе, а понедельник открывает новую", () => {
    expect(weekKey(new Date("2026-08-02T06:00:00Z"))).toBe(weekKey(new Date("2026-07-27T06:00:00Z")));
    expect(weekKey(new Date("2026-08-03T06:00:00Z"))).not.toBe(weekKey(new Date("2026-08-02T06:00:00Z")));
  });

  it("режется по поясу владельца, а не по UTC", () => {
    // Понедельник 03.08 в 02:00 Екатеринбурга = воскресенье 02.08 21:00 UTC.
    expect(weekKey(new Date("2026-08-02T21:00:00Z"))).toBe("2026-W32");
  });
});
