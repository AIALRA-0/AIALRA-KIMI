import { describe, expect, it } from "vitest";
import {
  AgentEnvelopeSchema,
  CapabilityGrantSchema,
  HostSessionRefSchema,
  isAgentOperation,
  PermissionModeSchema,
} from "../src/index.js";

describe("public protocol", () => {
  it("keeps the same upstream session id isolated by host", () => {
    const first = HostSessionRefSchema.parse({
      hostId: "host-alpha",
      upstreamSessionId: "session-shared",
    });
    const second = HostSessionRefSchema.parse({
      hostId: "host-bravo",
      upstreamSessionId: "session-shared",
    });

    expect(`${first.hostId}:${first.upstreamSessionId}`).not.toBe(
      `${second.hostId}:${second.upstreamSessionId}`,
    );
  });

  it.each(["manual", "auto", "yolo"])("accepts permission mode %s", (mode) => {
    expect(PermissionModeSchema.parse(mode)).toBe(mode);
  });

  it("rejects unknown operations", () => {
    expect(isAgentOperation("sessions.prompt")).toBe(true);
    expect(isAgentOperation("localhost.proxy")).toBe(false);
  });

  it("requires short-lived, host-bound grants", () => {
    const now = Math.floor(Date.now() / 1000);
    const grant = CapabilityGrantSchema.parse({
      grantId: "2c82eedc-d63b-4c78-afd6-4916cb2c770e",
      subject: "owner",
      hostId: "host-alpha",
      scopes: ["sessions.list"],
      issuedAt: now,
      expiresAt: now + 60,
      nonce: "a-unique-one-time-nonce",
    });

    expect(grant.expiresAt - grant.issuedAt).toBe(60);
  });

  it("accepts content-free agent audit events", () => {
    const event = AgentEnvelopeSchema.parse({
      type: "agent.audit",
      hostId: "host-alpha",
      channelId: "2c82eedc-d63b-4c78-afd6-4916cb2c770e",
      requestId: "92b11e67-6f24-474f-9510-816e92a6a69f",
      category: "sessions.prompt",
      outcome: "succeeded",
      occurredAt: "2026-08-29T00:00:00.000Z",
    });

    expect(event).not.toHaveProperty("body");
  });
});
