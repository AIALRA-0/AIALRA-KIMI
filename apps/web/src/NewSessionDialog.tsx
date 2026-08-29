import { X } from "lucide-react";
import { useState } from "react";
import type { PermissionMode } from "@aialra-kimi/protocol";

export interface NewSessionInput {
  workspace: string;
  title: string;
  permissionMode: PermissionMode;
}

export function NewSessionDialog({
  platform,
  defaultPermissionMode,
  onCreate,
  onClose,
}: {
  platform: "windows" | "linux";
  defaultPermissionMode: PermissionMode;
  onCreate(input: NewSessionInput): Promise<void>;
  onClose(): void;
}) {
  const [workspace, setWorkspace] = useState("");
  const [title, setTitle] = useState("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    defaultPermissionMode,
  );
  const [submitting, setSubmitting] = useState(false);
  return (
    <div
      className="dialog-scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="dialog-card"
        onSubmit={(event) => {
          event.preventDefault();
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
            <h2>选择执行工作区</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="关闭新建会话窗口"
          >
            <X size={17} />
          </button>
        </div>
        <label>
          此主机上的工作区
          <input
            autoFocus
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
            placeholder={
              platform === "windows"
                ? "C:\\Projects\\my-project"
                : "/srv/projects/my-project"
            }
            required
          />
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
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button
            className="primary-button"
            disabled={submitting || !workspace.trim()}
          >
            {submitting ? "正在创建…" : "创建会话"}
          </button>
        </div>
      </form>
    </div>
  );
}
