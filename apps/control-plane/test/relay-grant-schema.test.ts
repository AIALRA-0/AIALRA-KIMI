import { describe, expect, it } from "vitest";
import { AGENT_OPERATIONS } from "@aialra-kimi/protocol";
import { RelayGrantBody } from "../src/app.js";

describe("relay grant schema", () => {
  it("accepts the complete explicit agent operation allowlist", () => {
    expect(
      RelayGrantBody.safeParse({
        hostId: "host_12345678",
        scopes: [...AGENT_OPERATIONS],
        ttlSeconds: 60,
      }).success,
    ).toBe(true);
  });
});
