import { Check, Copy, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { HostMode } from "@aialra-kimi/protocol";
import { api } from "./api.js";
import { DialogShell } from "./DialogShell.js";

interface PairingCode {
  code: string;
  expiresAt: string;
}

export function PairingDialog({ onClose }: { onClose(): void }) {
  const [displayName, setDisplayName] = useState("");
  const [mode, setMode] = useState<HostMode>("remote");
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const command = useMemo(() => {
    if (!pairing) return "";
    const safeName = displayName.trim().replaceAll('"', "'");
    return `aialra-kimi-agent enroll --server ${window.location.origin} --code ${pairing.code} --name "${safeName}" --mode ${mode}`;
  }, [displayName, mode, pairing]);

  return (
    <DialogShell
      labelledBy="pairing-dialog-title"
      busy={submitting}
      onClose={onClose}
    >
      <form
        className="dialog-card pairing-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (submitting) return;
          setSubmitting(true);
          setError(null);
          void api
            .pairingCode(displayName.trim(), mode)
            .then(setPairing)
            .catch((nextError: unknown) =>
              setError(
                nextError instanceof Error
                  ? nextError.message
                  : "创建配对码失败",
              ),
            )
            .finally(() => setSubmitting(false));
        }}
      >
        <div className="dialog-head">
          <div>
            <p className="eyebrow">配对执行主机</p>
            <h2 id="pairing-dialog-title">
              {pairing ? "在目标主机上运行一次" : "命名新主机"}
            </h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={submitting}
            aria-label="关闭配对窗口"
          >
            <X size={17} />
          </button>
        </div>
        {pairing ? (
          <>
            <div className="pairing-code">
              <span>一次性配对码</span>
              <strong>{pairing.code}</strong>
              <small>
                到期时间{" "}
                {new Date(pairing.expiresAt).toLocaleTimeString("zh-CN")}
              </small>
            </div>
            <div className="pairing-command">
              <code>{command}</code>
              <button
                type="button"
                className="icon-button"
                aria-label="复制注册命令"
                onClick={() => {
                  void navigator.clipboard.writeText(command).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1600);
                  });
                }}
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
              </button>
            </div>
            <p className="dialog-note">
              配对码在 10 分钟后过期，成功注册 1 次后立即失效
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                className="primary-button"
                onClick={onClose}
              >
                完成
              </button>
            </div>
          </>
        ) : (
          <>
            <label>
              显示名称
              <input
                data-dialog-initial-focus="true"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="工作室电脑"
                maxLength={120}
                required
              />
            </label>
            <label>
              执行模式
              <select
                value={mode}
                onChange={(event) => setMode(event.target.value as HostMode)}
              >
                <option value="remote">远端主机</option>
                <option value="vps">VPS 主机</option>
              </select>
            </label>
            <p className="dialog-note">主机只主动向外连接，不开放公网端口</p>
            {error && <p className="dialog-error">{error}</p>}
            <div className="dialog-actions">
              <button type="button" onClick={onClose} disabled={submitting}>
                取消
              </button>
              <button
                className="primary-button"
                disabled={submitting || !displayName.trim()}
              >
                {submitting ? "正在创建…" : "创建一次性配对码"}
              </button>
            </div>
          </>
        )}
      </form>
    </DialogShell>
  );
}
