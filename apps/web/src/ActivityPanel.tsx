import {
  Activity,
  CircleCheck,
  CircleDot,
  FileCode2,
  Folder,
  X,
} from "lucide-react";
import type {
  UiFileEntry,
  UiFileRead,
  UiSessionStatus,
  UiTask,
} from "./session-model.js";

interface ActivityPanelProps {
  status: UiSessionStatus | null;
  loading?: boolean;
  state?: "loading" | "ready" | "reconnecting" | "offline" | "empty" | "error";
  view?: "conversation" | "terminal" | "account" | "settings" | "archive";
  hostName?: string | undefined;
  sequence: number;
  tasks: UiTask[];
  files: UiFileEntry[];
  changes: Record<string, string>;
  preview: UiFileRead | null;
  onOpenFile(path: string): void;
  onClosePreview(): void;
  onClose(): void;
}

function taskStatusLabel(status: UiTask["status"]): string {
  switch (status) {
    case "running":
      return "运行中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
  }
}

function changeStateLabel(state: string): string {
  const labels: Record<string, string> = {
    added: "新增",
    modified: "已修改",
    deleted: "已删除",
    renamed: "已重命名",
    untracked: "未跟踪",
  };
  return labels[state.toLowerCase()] ?? state;
}

export function ActivityPanel({
  status,
  loading = false,
  state = loading ? "loading" : "ready",
  view = "conversation",
  hostName,
  sequence,
  tasks,
  files,
  changes,
  preview,
  onOpenFile,
  onClosePreview,
  onClose,
}: ActivityPanelProps) {
  const contextPercent = (() => {
    const raw =
      status?.contextUsage !== null && status?.contextUsage !== undefined
        ? status.contextUsage * 100
        : status?.maxContextTokens
          ? (status.contextTokens / status.maxContextTokens) * 100
          : null;
    return raw === null ? null : Math.min(100, Math.max(0, Math.round(raw)));
  })();
  const changeEntries = Object.entries(changes);
  const heading =
    view === "terminal"
      ? "终端活动"
      : view === "archive"
        ? "归档管理"
        : view === "account"
          ? "账号活动"
          : view === "settings"
            ? "主机状态"
            : "会话活动";
  const statusHeading =
    state === "loading"
      ? "正在加载详情"
      : state === "reconnecting"
        ? "正在恢复详情"
        : state === "offline"
          ? "主机离线"
          : state === "empty"
            ? "尚未选择会话"
            : state === "error"
              ? "详情暂时不可用"
              : status?.busy
                ? "Kimi 正在工作"
                : "空闲";
  return (
    <aside className="details-panel">
      <div className="details-head">
        <strong>{heading}</strong>
        <button className="icon-button" onClick={onClose} aria-label="关闭详情">
          <X size={16} />
        </button>
      </div>
      <section className="detail-section">
        <p className="section-label">实时状态</p>
        <div className="status-card">
          <div className="status-icon">
            <Activity size={18} />
          </div>
          <div>
            <strong>{statusHeading}</strong>
            <span>
              {hostName ? `${hostName} · ` : ""}
              {state === "ready" || status
                ? `序列 ${sequence.toLocaleString()} · ${status?.model ?? "默认模型"}`
                : "等待主机返回状态"}
            </span>
          </div>
          {state === "ready" && status?.busy && <i className="pulse" />}
        </div>
      </section>
      <section className="detail-section">
        <p className="section-label">任务</p>
        {tasks.slice(0, 8).map((task) => (
          <div
            className={`task-row ${task.status === "completed" ? "done" : task.status}`}
            key={task.id}
          >
            {task.status === "completed" ? (
              <CircleCheck size={16} />
            ) : (
              <CircleDot size={16} />
            )}
            <div>
              <strong>{task.description || task.kind}</strong>
              <span>
                {taskStatusLabel(task.status)}
                {task.model ? ` · ${task.model}` : ""}
              </span>
            </div>
          </div>
        ))}
        {!tasks.length && <p className="empty-detail">没有后台任务</p>}
      </section>
      <section className="detail-section">
        <div className="detail-title">
          <p className="section-label">文件变更</p>
          <span>{changeEntries.length}</span>
        </div>
        {changeEntries.slice(0, 10).map(([path, state]) => (
          <button
            className="file-row"
            key={path}
            onClick={() => onOpenFile(path)}
          >
            <FileCode2 size={15} />
            <span>{path}</span>
            <em>{changeStateLabel(state)}</em>
          </button>
        ))}
        {!changeEntries.length && (
          <p className="empty-detail">没有检测到 Git 变更</p>
        )}
      </section>
      <section className="detail-section">
        <div className="detail-title">
          <p className="section-label">工作区文件</p>
          <span>{files.length}</span>
        </div>
        {files.slice(0, 10).map((file) => (
          <button
            className="file-row"
            key={file.path}
            disabled={file.kind !== "file"}
            onClick={() => onOpenFile(file.path)}
          >
            {file.kind === "directory" ? (
              <Folder size={15} />
            ) : (
              <FileCode2 size={15} />
            )}
            <span>{file.path}</span>
          </button>
        ))}
        {!files.length && <p className="empty-detail">没有返回文件</p>}
      </section>
      <section className="detail-section context-section">
        <div className="detail-title">
          <p className="section-label">上下文</p>
          <span>{contextPercent === null ? "—" : `${contextPercent}%`}</span>
        </div>
        <div className="context-track">
          <i style={{ width: `${contextPercent ?? 0}%` }} />
        </div>
        <small>
          {status
            ? `${status.contextTokens.toLocaleString()}${status.maxContextTokens ? ` / ${status.maxContextTokens.toLocaleString()}` : ""} 个词元`
            : "上下文不可用"}
        </small>
      </section>
      {preview && (
        <div className="file-preview">
          <div>
            <strong>{preview.path}</strong>
            <button
              className="icon-button"
              onClick={onClosePreview}
              aria-label="关闭文件预览"
            >
              <X size={15} />
            </button>
          </div>
          {preview.is_binary || preview.encoding === "base64" ? (
            <p>二进制文件不提供预览</p>
          ) : (
            <pre>{preview.content}</pre>
          )}
          {preview.truncated && (
            <small>预览已截断 · 共 {preview.size.toLocaleString()} 字节</small>
          )}
        </div>
      )}
    </aside>
  );
}
