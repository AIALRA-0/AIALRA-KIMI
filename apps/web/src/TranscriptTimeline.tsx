import {
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Command,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CopyButton, MarkdownMessage } from "./MessageBody.js";
import { turnTraceDefaultOpen } from "./transcript-model.js";
import type {
  TranscriptFrame,
  TranscriptState,
  TranscriptStep,
  TranscriptToolFrame,
  TranscriptTurn,
} from "./transcript-model.js";

interface TranscriptTimelineProps {
  transcript: TranscriptState;
  hostId: string;
  sessionId: string;
  collapseCompleted?: boolean;
  autoCollapsedTurnIds?: ReadonlySet<string>;
  onLoadOlder?: () => void;
  loadingOlder?: boolean;
}

function formatDuration(turn: TranscriptTurn): string {
  const duration =
    turn.durationMs ??
    (turn.startedAt && turn.endedAt
      ? Date.parse(turn.endedAt) - Date.parse(turn.startedAt)
      : 0);
  if (!Number.isFinite(duration) || duration <= 0) return "";
  if (duration < 1_000) return `${duration} 毫秒`;
  if (duration < 60_000) return `${(duration / 1_000).toFixed(1)} 秒`;
  return `${Math.floor(duration / 60_000)} 分 ${Math.round((duration % 60_000) / 1_000)} 秒`;
}

function timeLabel(value?: string): string {
  if (!value) return "";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
}

function frameCount(turn: TranscriptTurn): number {
  return turn.steps.reduce(
    (total, step) =>
      total +
      step.frames.filter(
        (frame) => frame.kind !== "text" || frame.role !== "assistant",
      ).length +
      (step.retry ? 1 : 0),
    0,
  );
}

function assistantText(turn: TranscriptTurn): string {
  return turn.steps
    .flatMap((step) => step.frames)
    .filter(
      (frame): frame is Extract<TranscriptFrame, { kind: "text" }> =>
        frame.kind === "text" && frame.role === "assistant",
    )
    .map((frame) => frame.text)
    .join("");
}

function jsonText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stateLabel(state: TranscriptTurn["state"]): string {
  if (state === "running" || state === "queued") return "运行中";
  if (state === "failed") return "失败";
  if (state === "cancelled") return "已中止";
  return "已完成";
}

function readManualOpen(storageKey: string): boolean | null {
  try {
    const value = sessionStorage.getItem(storageKey);
    return value === "open" ? true : value === "closed" ? false : null;
  } catch {
    return null;
  }
}

function useManualOpen(storageKey: string, defaultOpen: boolean) {
  const [manual, setManual] = useState<boolean | null>(() =>
    readManualOpen(storageKey),
  );
  const open = manual ?? defaultOpen;
  useEffect(() => {
    try {
      if (manual === null) sessionStorage.removeItem(storageKey);
      else sessionStorage.setItem(storageKey, manual ? "open" : "closed");
    } catch {
      // A restricted storage context should not break transcript rendering.
    }
  }, [manual, storageKey]);
  return [open, () => setManual(!open)] as const;
}

function ThinkingFrame({
  frame,
  turnRunning,
  storageKey,
}: {
  frame: Extract<TranscriptFrame, { kind: "thinking" }>;
  turnRunning: boolean;
  storageKey: string;
}) {
  const [open, toggle] = useManualOpen(storageKey, turnRunning);
  return (
    <details className="trace-part thinking-part" open={open}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          toggle();
        }}
      >
        <ChevronRight size={14} />
        <Brain size={14} />
        <strong>思考</strong>
        <span>{frame.text.length.toLocaleString()} 字符</span>
      </summary>
      <div className="trace-part-body">
        <MarkdownMessage text={frame.text || "正在思考"} />
      </div>
    </details>
  );
}

function NoticeFrame({
  frame,
  storageKey,
}: {
  frame: Extract<TranscriptFrame, { kind: "notice" }>;
  storageKey: string;
}) {
  const [open, toggle] = useManualOpen(storageKey, frame.level === "error");
  return (
    <details className={`trace-part notice-part ${frame.level}`} open={open}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          toggle();
        }}
      >
        <ChevronRight size={14} />
        <CircleAlert size={14} />
        <strong>
          {frame.level === "error"
            ? "错误"
            : frame.level === "warning"
              ? "警告"
              : "提示"}
        </strong>
        <span>{frame.message}</span>
      </summary>
      {frame.detail !== undefined && (
        <div className="trace-part-body">
          <pre>{jsonText(frame.detail)}</pre>
        </div>
      )}
    </details>
  );
}

function TraceFrame({
  frame,
  turnRunning,
  storageKey,
}: {
  frame: TranscriptFrame;
  turnRunning: boolean;
  storageKey: string;
}) {
  if (frame.kind === "text" && frame.role === "assistant") return null;
  if (frame.kind === "thinking")
    return (
      <ThinkingFrame
        frame={frame}
        turnRunning={turnRunning}
        storageKey={storageKey}
      />
    );
  if (frame.kind === "tool")
    return <ToolFrame frame={frame} storageKey={storageKey} />;
  if (frame.kind === "notice")
    return <NoticeFrame frame={frame} storageKey={storageKey} />;
  return null;
}

function ToolFrame({
  frame,
  storageKey,
}: {
  frame: TranscriptToolFrame;
  storageKey: string;
}) {
  const running = frame.state === "running";
  const failed = frame.state === "error";
  const Icon = running ? LoaderCircle : failed ? CircleAlert : Check;
  const [open, toggle] = useManualOpen(storageKey, running || failed);
  const [inputOpen, toggleInput] = useManualOpen(`${storageKey}:input`, false);
  const [outputOpen, toggleOutput] = useManualOpen(
    `${storageKey}:output`,
    failed,
  );
  return (
    <details
      className={`trace-part tool-part ${failed ? "error" : ""}`}
      open={open}
    >
      <summary
        onClick={(event) => {
          event.preventDefault();
          toggle();
        }}
      >
        <ChevronRight size={14} />
        <Command size={14} />
        <strong>{frame.name || "工具"}</strong>
        <span className="trace-part-status">
          <Icon className={running ? "spin" : ""} size={13} />
          {running ? "运行中" : failed ? "失败" : "已完成"}
          {typeof frame.progress?.percent === "number" &&
            ` ${Math.round(frame.progress.percent)}%`}
        </span>
      </summary>
      <div className="trace-part-body nested-trace">
        {(frame.inputText ||
          frame.input !== undefined ||
          frame.display !== undefined) && (
          <details open={inputOpen}>
            <summary
              onClick={(event) => {
                event.preventDefault();
                toggleInput();
              }}
            >
              <ChevronRight size={13} /> 输入
            </summary>
            <div className="trace-copy-wrap">
              <pre>
                {frame.inputText || jsonText(frame.display ?? frame.input)}
              </pre>
              <CopyButton
                text={frame.inputText || jsonText(frame.display ?? frame.input)}
              />
            </div>
          </details>
        )}
        {(frame.output !== undefined ||
          frame.error ||
          frame.progress?.text) && (
          <details open={outputOpen}>
            <summary
              onClick={(event) => {
                event.preventDefault();
                toggleOutput();
              }}
            >
              <ChevronRight size={13} /> {failed ? "错误" : "结果"}
            </summary>
            <div className="trace-copy-wrap">
              <pre>
                {frame.error || jsonText(frame.output) || frame.progress?.text}
              </pre>
              <CopyButton
                text={
                  frame.error ||
                  jsonText(frame.output) ||
                  frame.progress?.text ||
                  ""
                }
              />
            </div>
          </details>
        )}
        {frame.agentRefs && frame.agentRefs.length > 0 && (
          <p className="trace-agent-ref">
            子代理 {frame.agentRefs.map((agent) => agent.agentId).join("、")}
          </p>
        )}
      </div>
    </details>
  );
}

function StepTrace({
  step,
  storagePrefix,
}: {
  step: TranscriptStep;
  storagePrefix: string;
}) {
  const frames = step.frames.filter(
    (frame) => frame.kind !== "text" || frame.role !== "assistant",
  );
  return (
    <div className="step-trace">
      {step.retry && (
        <details
          className="trace-part retry-part"
          open={step.state === "running"}
        >
          <summary>
            <ChevronRight size={14} />
            <RefreshCw size={14} />
            <strong>正在重试</strong>
            <span>
              第 {step.retry.nextAttempt} / {step.retry.maxAttempts} 次
            </span>
          </summary>
          <div className="trace-part-body">
            <p>{step.retry.errorMessage}</p>
            <small>{step.retry.delayMs} 毫秒后继续</small>
          </div>
        </details>
      )}
      {frames.map((frame) => (
        <TraceFrame
          key={frame.frameId}
          frame={frame}
          turnRunning={step.state === "running"}
          storageKey={`${storagePrefix}:frame:${frame.frameId}`}
        />
      ))}
    </div>
  );
}

function TurnCard({
  turn,
  latest,
  collapseCompleted,
  autoCollapsed,
  storageKey,
}: {
  turn: TranscriptTurn;
  latest: boolean;
  collapseCompleted: boolean;
  autoCollapsed: boolean;
  storageKey: string;
}) {
  const running = turn.state === "running" || turn.state === "queued";
  const defaultOpen = turnTraceDefaultOpen(
    turn.state,
    latest,
    collapseCompleted || autoCollapsed,
  );
  const [open, toggle] = useManualOpen(storageKey, defaultOpen);
  const output = assistantText(turn);
  const count = frameCount(turn);

  return (
    <article className={`transcript-turn ${running ? "running" : turn.state}`}>
      <div className="turn-message user-turn-message">
        <div className="message-avatar">
          <UserRound size={16} />
        </div>
        <div className="message-content">
          <div className="message-meta">
            <strong>你</strong>
            <span>{timeLabel(turn.startedAt)}</span>
          </div>
          <MarkdownMessage text={turn.prompt || "无文字提示"} />
          {turn.attachmentIds && turn.attachmentIds.length > 0 && (
            <p className="attachment-summary">
              {turn.attachmentIds.length} 个附件
            </p>
          )}
          <div className="message-actions">
            <CopyButton text={turn.prompt || ""} />
          </div>
        </div>
      </div>

      {count > 0 && (
        <details className="turn-trace" open={open}>
          <summary
            onClick={(event) => {
              event.preventDefault();
              toggle();
            }}
          >
            <ChevronRight size={15} />
            {running ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Brain size={15} />
            )}
            <strong>思考与操作</strong>
            <span>{count} 项</span>
            <span className="turn-duration">{formatDuration(turn) || "—"}</span>
            <em>{stateLabel(turn.state)}</em>
          </summary>
          <div className="turn-trace-body">
            {turn.steps.map((step) => (
              <StepTrace
                key={step.stepId}
                step={step}
                storagePrefix={`${storageKey}:step:${step.stepId}`}
              />
            ))}
          </div>
        </details>
      )}

      {(output || running || turn.error) && (
        <div className="turn-message assistant-turn-message">
          <div className="message-avatar">
            <Sparkles size={17} />
          </div>
          <div className="message-content">
            <div className="message-meta">
              <strong>Kimi</strong>
              <span>{timeLabel(turn.endedAt)}</span>
              {running && <em>处理中</em>}
            </div>
            {output ? (
              <MarkdownMessage text={output} />
            ) : turn.error ? (
              <p className="turn-error">{turn.error}</p>
            ) : (
              <div className="working-line" aria-label="Kimi 正在处理">
                <i />
                <i />
                <i />
              </div>
            )}
            <div className="message-actions">
              {output && <CopyButton text={output} />}
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

export function TranscriptTimeline({
  transcript,
  hostId,
  sessionId,
  collapseCompleted = false,
  autoCollapsedTurnIds,
  onLoadOlder,
  loadingOlder,
}: TranscriptTimelineProps) {
  const turns = useMemo(
    () =>
      transcript.items
        .filter((item): item is TranscriptTurn => item.kind === "turn")
        .sort((left, right) => left.ordinal - right.ordinal),
    [transcript.items],
  );
  return (
    <div className="transcript-timeline">
      {transcript.hasMoreOlder && onLoadOlder && (
        <button
          className="load-older-button"
          onClick={onLoadOlder}
          disabled={loadingOlder}
        >
          <Clock3 size={14} /> {loadingOlder ? "正在加载" : "加载更早 20 轮"}
        </button>
      )}
      {turns.map((turn, index) => (
        <TurnCard
          key={turn.turnId}
          turn={turn}
          latest={index === turns.length - 1}
          collapseCompleted={collapseCompleted}
          autoCollapsed={autoCollapsedTurnIds?.has(turn.turnId) ?? false}
          storageKey={`aialra-fold:${hostId}:${sessionId}:${turn.turnId}`}
        />
      ))}
    </div>
  );
}
