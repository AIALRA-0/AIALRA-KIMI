import { describe, expect, it } from "vitest";
import { demoHosts, demoSessions, demoUsage } from "../src/demo.js";

describe("synthetic preview fixtures", () => {
  it("contains no URL and uses only a reserved account domain", () => {
    const serialized = JSON.stringify({ demoHosts, demoSessions, demoUsage });
    expect(serialized).not.toMatch(/https?:\/\//);
    expect(serialized).toContain("example.invalid");
  });

  it("keeps session keys host-scoped", () => {
    const keys = demoSessions.map(
      (session) => `${session.hostId}:${session.upstreamSessionId}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
