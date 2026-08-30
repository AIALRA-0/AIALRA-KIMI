import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  allowedKimiVerificationUrl,
  KimiOAuthPanel,
  type OAuthFlow,
} from "../src/KimiOAuthPanel.js";

const pendingFlow: OAuthFlow = {
  flow_id: "flow-1",
  status: "pending",
  user_code: "ABCD-EFGH",
  verification_uri_complete:
    "https://www.kimi.com/code/authorize_device?user_code=ABCD-EFGH",
};

describe("Kimi OAuth panel", () => {
  it("only accepts official HTTPS verification hosts", () => {
    expect(
      allowedKimiVerificationUrl(
        "https://www.kimi.com/code/authorize_device?user_code=A",
      ),
    ).toContain("www.kimi.com");
    expect(allowedKimiVerificationUrl("https://www.kimi.ai/code")).toContain(
      "www.kimi.ai",
    );
    expect(allowedKimiVerificationUrl("https://www.kimi.cn/code")).toBeNull();
    expect(
      allowedKimiVerificationUrl("https://login.www.kimi.com/code"),
    ).toBeNull();
    expect(allowedKimiVerificationUrl("http://www.kimi.com/code")).toBeNull();
  });

  it("renders the mainland two-step authorization flow", () => {
    const html = renderToStaticMarkup(
      <KimiOAuthPanel
        online
        region="mainland-cn"
        flow={pendingFlow}
        message="等待授权"
        onRegionChange={vi.fn()}
        onStart={vi.fn()}
      />,
    );

    expect(html).toContain("设备授权页不提供中国大陆手机号登录");
    expect(html).toContain("https://www.kimi.com/code");
    expect(html).toContain("已登录，继续授权此主机");
    expect(html).toContain("ABCD-EFGH");
    expect(html).not.toContain("kimi.cn");
  });

  it("offers a retry when authorization expires", () => {
    const html = renderToStaticMarkup(
      <KimiOAuthPanel
        online
        region="mainland-cn"
        flow={{ ...pendingFlow, status: "expired" }}
        message="授权失败"
        onRegionChange={vi.fn()}
        onStart={vi.fn()}
      />,
    );

    expect(html).toContain("重新生成授权码");
    expect(html).toContain("授权码已经过期");
  });
});
