import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";

vi.mock("openid-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openid-client")>();
  return { ...actual, discovery: vi.fn() };
});

import { discovery } from "openid-client";
import { AuthService, safeReturnPath } from "../src/auth.js";

describe("identity redirects", () => {
  const origin = new URL("https://kimi.example.invalid");

  it("keeps same-origin paths", () => {
    expect(safeReturnPath("/session?elevated=1#terminal", origin)).toBe(
      "/session?elevated=1#terminal",
    );
  });

  it.each([
    "https://attacker.invalid",
    "//attacker.invalid",
    "/\\attacker.invalid",
    "/safe\r\nLocation: https://attacker.invalid",
  ])("rejects external or ambiguous return target %s", (target) => {
    expect(safeReturnPath(target, origin)).toBe("/");
  });
});

describe("OIDC discovery recovery", () => {
  it("does not cache a rejected discovery promise forever", async () => {
    const mockedDiscovery = vi.mocked(discovery);
    mockedDiscovery
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValue({} as Awaited<ReturnType<typeof discovery>>);
    const service = new AuthService({
      oidc: {
        issuer: new URL("https://issuer.example.invalid"),
        clientId: "client",
        clientSecret: "secret",
        redirectUri: new URL("https://app.example.invalid/auth/callback"),
        ownerGroup: "owner",
      },
      elevationOidc: null,
    } as AppConfig);
    const provider = (
      service as unknown as {
        provider(): Promise<unknown>;
      }
    ).provider.bind(service);

    await expect(provider()).rejects.toThrow("temporarily unavailable");
    await expect(provider()).resolves.toEqual({});
    expect(mockedDiscovery).toHaveBeenCalledTimes(2);
  });
});
