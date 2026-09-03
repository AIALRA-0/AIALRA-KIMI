import { describe, expect, it } from "vitest";
import { demoHosts } from "../src/demo.js";
import {
  canSendPrompt,
  isHostChannelReady,
  isKimiAuthenticationError,
  kimiErrorText,
  sameHosts,
} from "../src/readiness.js";

describe("web readiness gates", () => {
  it("requires an authenticated Kimi account in addition to a live channel", () => {
    const host = demoHosts[0]!;
    expect(isHostChannelReady(host, true, false)).toBe(true);
    expect(
      isHostChannelReady(
        { ...host, loginState: "unauthenticated" },
        true,
        false,
      ),
    ).toBe(false);
    expect(
      isHostChannelReady({ ...host, loginState: "unknown" }, true, false),
    ).toBe(false);
    expect(canSendPrompt(host, true, true, false, false, true)).toBe(true);
    expect(
      canSendPrompt(
        { ...host, loginState: "unauthenticated" },
        true,
        true,
        false,
        false,
        true,
      ),
    ).toBe(false);
  });

  it("maps the upstream missing-credential error without exposing its raw text", () => {
    expect(
      kimiErrorText(
        "Kimi request failed with code 40111: provider managed:kimi-code has no credential configured",
      ),
    ).toBe("这台主机尚未登录 Kimi Code，请先完成账号授权");
    expect(
      isKimiAuthenticationError(new Error("No token for 'kimi-code'")),
    ).toBe(true);
    expect(isKimiAuthenticationError(new Error("network timeout"))).toBe(false);
  });

  it("recognizes unchanged host snapshots", () => {
    expect(sameHosts(demoHosts, [...demoHosts])).toBe(true);
    expect(
      sameHosts(demoHosts, [
        demoHosts[0]!,
        { ...demoHosts[1]!, loginState: "unknown" },
        demoHosts[2]!,
      ]),
    ).toBe(false);
  });
});
