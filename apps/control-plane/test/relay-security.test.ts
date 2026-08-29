import { describe, expect, it } from "vitest";
import { consumeRate, parseCookies } from "../src/relay.js";

describe("relay input hardening", () => {
  it("ignores malformed cookie encoding without throwing", () => {
    expect(parseCookies("valid=one; broken=%E0%A4%A; another=two")).toEqual({
      valid: "one",
      another: "two",
    });
  });

  it("enforces a bounded rate window and resets at the boundary", () => {
    const window = { startedAt: 1_000, count: 0 };
    expect(consumeRate(window, 2, 10_000, 1_001)).toBe(true);
    expect(consumeRate(window, 2, 10_000, 1_002)).toBe(true);
    expect(consumeRate(window, 2, 10_000, 1_003)).toBe(false);
    expect(consumeRate(window, 2, 10_000, 11_000)).toBe(true);
    expect(window).toEqual({ startedAt: 11_000, count: 1 });
  });
});
