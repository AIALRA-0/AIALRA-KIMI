export type KimiOAuthRegion = "mainland-cn" | "global";

export interface OAuthFlow {
  flow_id: string;
  status: "pending" | "authenticated" | "denied" | "expired" | "cancelled";
  verification_uri?: string;
  verification_uri_complete?: string;
  user_code?: string;
  expires_at?: string;
  interval?: number;
  error_message?: string;
}

interface KimiOAuthPanelProps {
  online: boolean;
  region: KimiOAuthRegion;
  flow: OAuthFlow | null;
  message: string;
  onRegionChange: (region: KimiOAuthRegion) => void;
  onStart: () => void;
}

const verificationHosts = new Set(["www.kimi.com", "www.kimi.ai"]);

export function allowedKimiVerificationUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && verificationHosts.has(parsed.host)
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function flowStatusText(flow: OAuthFlow): string {
  if (flow.error_message) return flow.error_message;
  switch (flow.status) {
    case "denied":
      return "Kimi 已拒绝这次设备授权";
    case "expired":
      return "授权码已经过期，请重新生成";
    case "cancelled":
      return "这次设备授权已取消";
    case "authenticated":
      return "这台主机已经完成 Kimi 授权";
    default:
      return "正在等待 Kimi 完成设备授权";
  }
}

export function KimiOAuthPanel({
  online,
  region,
  flow,
  message,
  onRegionChange,
  onStart,
}: KimiOAuthPanelProps) {
  const verificationUrl = allowedKimiVerificationUrl(
    flow?.verification_uri_complete ?? flow?.verification_uri,
  );
  const pending = flow?.status === "pending";
  const failed =
    flow !== null &&
    flow.status !== "pending" &&
    flow.status !== "authenticated";

  return (
    <section className="kimi-oauth-panel" aria-labelledby="kimi-oauth-title">
      <div className="kimi-oauth-summary">
        <div>
          <p className="eyebrow">Kimi Code OAuth</p>
          <h2 id="kimi-oauth-title">授权执行主机</h2>
          <p>{message}</p>
        </div>
        <div className="oauth-login-actions">
          <label>
            账号地区
            <select
              aria-label="Kimi 账号地区"
              value={region}
              onChange={(event) =>
                onRegionChange(event.target.value as KimiOAuthRegion)
              }
            >
              <option value="mainland-cn">中国大陆账号</option>
              <option value="global">全球账号</option>
            </select>
          </label>
          <button
            className="primary-button"
            disabled={!online || pending}
            onClick={onStart}
          >
            {failed ? "重新生成授权码" : "授权此主机"}
          </button>
        </div>
      </div>

      {pending && (
        <div className="oauth-device">
          <div className="oauth-code-block">
            <span>设备验证码</span>
            <strong>{flow.user_code ?? "等待官方返回"}</strong>
          </div>
          {region === "mainland-cn" ? (
            <div className="oauth-steps">
              <p className="oauth-warning">
                设备授权页不提供中国大陆手机号登录，请先完成普通官网登录
              </p>
              <div className="oauth-step">
                <span>1</span>
                <div className="oauth-step-copy">
                  <strong>先登录 Kimi 官网</strong>
                  <p>在普通登录弹窗中选择中国大陆 +86</p>
                </div>
                <a
                  className="secondary-action"
                  href="https://www.kimi.com/code"
                  target="_blank"
                  rel="noreferrer"
                >
                  打开 Kimi 官网
                </a>
              </div>
              <div className="oauth-step">
                <span>2</span>
                <div className="oauth-step-copy">
                  <strong>继续设备授权</strong>
                  <p>官网登录成功后再打开设备确认页面</p>
                </div>
                {verificationUrl ? (
                  <a
                    className="primary-button"
                    href={verificationUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    已登录，继续授权此主机
                  </a>
                ) : (
                  <em>官方返回了不受支持的授权地址</em>
                )}
              </div>
            </div>
          ) : verificationUrl ? (
            <a
              className="primary-button oauth-global-action"
              href={verificationUrl}
              target="_blank"
              rel="noreferrer"
            >
              打开 Kimi 设备授权页
            </a>
          ) : (
            <p className="oauth-warning">官方返回了不受支持的授权地址</p>
          )}
        </div>
      )}

      {flow && flow.status !== "pending" && (
        <div className={`oauth-result ${flow.status}`} role="status">
          <strong>{flowStatusText(flow)}</strong>
        </div>
      )}
    </section>
  );
}
