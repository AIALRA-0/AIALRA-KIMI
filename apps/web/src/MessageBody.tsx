import { Check, ChevronRight, CircleAlert, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { UiMessage } from "./session-model.js";

export function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function toolLabel(name?: string): string {
  const normalized = name?.trim().toLowerCase();
  if (normalized === "shell" || normalized === "bash") return "Shell";
  if (normalized === "result") return "结果";
  return name?.trim() || "工具";
}

export function ToolMessage({ message }: { message: UiMessage }) {
  const wasStreaming = useRef(Boolean(message.streaming));
  const [open, setOpen] = useState(
    Boolean(message.streaming || message.isError),
  );

  useEffect(() => {
    if (message.isError || message.streaming) setOpen(true);
    else if (wasStreaming.current) setOpen(false);
    wasStreaming.current = Boolean(message.streaming);
  }, [message.isError, message.streaming]);

  const status = message.isError
    ? "失败"
    : message.streaming
      ? "运行中"
      : "已完成";
  const StatusIcon = message.isError
    ? CircleAlert
    : message.streaming
      ? LoaderCircle
      : Check;

  return (
    <details
      className={`tool-card ${message.isError ? "error" : ""}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <ChevronRight className="tool-card-chevron" size={15} />
        <strong>{toolLabel(message.toolName)}</strong>
        <span className="tool-card-status">
          <StatusIcon
            className={message.streaming ? "tool-card-spinner" : ""}
            size={13}
          />
          {status}
        </span>
      </summary>
      <div className="tool-card-body">
        {message.toolInput && (
          <section>
            <h4>输入</h4>
            <pre>
              <code>{message.toolInput}</code>
            </pre>
          </section>
        )}
        {message.toolOutput && (
          <section>
            <h4>结果</h4>
            <pre>
              <code>{message.toolOutput}</code>
            </pre>
          </section>
        )}
        {!message.toolInput && !message.toolOutput && (
          <p className="tool-card-empty">没有可显示的内容</p>
        )}
      </div>
    </details>
  );
}
