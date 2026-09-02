import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { PermissionMode } from "@aialra-kimi/protocol";
import { DialogShell } from "./DialogShell.js";

export interface NewSessionInput {
  workspace: string;
  title: string;
  permissionMode: PermissionMode;
}

export interface WorkspaceOption {
  root: string;
  name: string;
}

export function NewSessionDialog({
  platform,
  defaultPermissionMode,
  recentWorkspaces = [],
  workspaceMissing = false,
  submitting: externalSubmitting = false,
  onCreate,
  onEnsureWorkspace,
  onClose,
}: {
  platform: "windows" | "linux";
  defaultPermissionMode: PermissionMode;
  recentWorkspaces?: WorkspaceOption[];
  workspaceMissing?: boolean;
  submitting?: boolean;
  onCreate(input: NewSessionInput): Promise<void>;
  onEnsureWorkspace?(): Promise<void>;
  onClose(): void;
}) {
  const [workspace, setWorkspace] = useState(recentWorkspaces[0]?.root ?? "");
  const [title, setTitle] = useState("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    defaultPermissionMode,
  );
  const [localSubmitting, setSubmitting] = useState(false);
  const busy = localSubmitting || externalSubmitting;
  useEffect(() => {
    setWorkspace((current) => current || recentWorkspaces[0]?.root || "");
  }, [recentWorkspaces]);
  return (
    <DialogShell labelledBy="new-session-title" busy={busy} onClose={onClose}>
      <form
        className="dialog-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          setSubmitting(true);
          void onCreate({
            workspace: workspace.trim(),
            title: title.trim(),
            permissionMode,
          }).finally(() => setSubmitting(false));
        }}
      >
        <div className="dialog-head">
          <div>
            <p className="eyebrow">新建 KIMI 会话</p>
            <h2 id="new-session-title">选择执行工作区</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭新建会话窗口"
          >
            <X size={17} />
          </button>
        </div>
        <label>
          此主机上的工作区
          <input
            data-dialog-initial-focus="true"
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
            placeholder={
              platform === "windows"
                ? "C:\\Projects\\my-project"
                : "/srv/projects/my-project"
            }
            required
            list="recent-kimi-workspaces"
          />
          <datalist id="recent-kimi-workspaces">
            {recentWorkspaces.map((item) => (
              <option key={item.root} value={item.root}>
                {item.name}
              </option>
            ))}
          </datalist>
        </label>
        <label>
          标题，可选
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="未命名会话"
          />
        </label>
        <label>
          默认权限模式
          <select
            value={permissionMode}
            onChange={(event) =>
              setPermissionMode(event.target.value as PermissionMode)
            }
          >
            <option value="manual">手动</option>
            <option value="auto">自动</option>
            <option value="yolo">YOLO</option>
          </select>
        </label>
        <p className="dialog-note">
          完整路径只通过浏览器到目标主机的加密通道传输
        </p>
        {workspaceMissing && (
          <div className="workspace-missing" role="alert">
            <strong>工作区不存在</strong>
            <span>可以在目标主机创建这个目录，然后继续创建会话</span>
            {onEnsureWorkspace && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => void onEnsureWorkspace()}
                disabled={busy}
              >
                创建工作区并重试
              </button>
            )}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="primary-button"
            disabled={busy || !workspace.trim()}
          >
            {busy ? "正在创建…" : "创建会话"}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}
