import {
  Archive,
  Bot,
  CircleDot,
  Clock3,
  Command,
  Gauge,
  GitBranch,
  Laptop,
  LoaderCircle,
  Menu,
  MessageSquare,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Send,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Sun,
  TerminalSquare,
  WifiOff,
  X,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type {
  HostDescriptor,
  PermissionMode,
  UsageSnapshot,
} from "@aialra-kimi/protocol";
import { ActivityPanel } from "./ActivityPanel.js";
import { ApiError, api } from "./api.js";
import {
  BUILTIN_COMMANDS,
  CommandMenu,
  filterCommands,
  mergeCommands,
  type CommandDescriptor,
} from "./CommandMenu.js";
import {
  demoHosts,
  demoMessages,
  demoSessions,
  demoUsage,
  type UiSession,
} from "./demo.js";
import { InteractionCards } from "./InteractionCards.js";
import {
  FileMentionMenu,
  insertFileMention,
  matchingFiles,
  mentionQuery,
} from "./FileMentionMenu.js";
import {
  allowedKimiVerificationUrl,
  KimiOAuthPanel,
  type KimiOAuthRegion,
  type OAuthFlow,
} from "./KimiOAuthPanel.js";
import { CopyButton, MarkdownMessage, ToolMessage } from "./MessageBody.js";
import { DialogShell } from "./DialogShell.js";
import { supportedEfforts } from "./model-options.js";
import {
  NewSessionDialog,
  type NewSessionInput,
  type WorkspaceOption,
} from "./NewSessionDialog.js";
import { PairingDialog } from "./PairingDialog.js";
import { relayRetryDelay, transcriptRetryDelay } from "./recovery-policy.js";
import {
  canSendPrompt,
  isHostChannelReady,
  isKimiAuthenticationError,
  kimiErrorText,
  sameHosts,
} from "./readiness.js";
import {
  BrowserRelay,
  type HostStatusUpdate,
  type RelayChannel,
} from "./relay.js";
import { TranscriptTimeline } from "./TranscriptTimeline.js";
import {
  applyTranscriptReset,
  applyTranscriptOps,
  emptyTranscript,
  mergeTranscriptPage,
  prependTranscriptPage,
  shouldRenderTranscript,
  transcriptFromPage,
  type TranscriptOperation,
  type TranscriptPage,
  type TranscriptState,
} from "./transcript-model.js";
import {
  appendAssistantDelta,
  coalesceToolMessages,
  decodeKimiEvent,
  finishAssistantTurn,
  hostSessionKey,
  turnFailureMessage,
  shouldApplySequence,
  withInFlightMessage,
  type UiFileEntry,
  type UiFileRead,
  type UiMessage,
  type UiSessionSnapshot,
  type UiSessionStatus,
  type UiTask,
  type KimiEventEnvelope,
} from "./session-model.js";

type MainView =
  | "conversation"
  | "terminal"
  | "account"
  | "settings"
  | "archive";

type LoadPhase =
  | "loading"
  | "ready"
  | "empty"
  | "offline"
  | "reconnecting"
  | "error";
type TerminalPhase = Exclude<LoadPhase, "empty">;
type PromptActionState =
  | "idle"
  | "applying"
  | "pending-confirmation"
  | "confirmed"
  | "failed";

interface PendingAttachment {
  id: string;
  file: File;
  status: "ready" | "uploading" | "failed";
  error?: string;
}

interface ModelDescriptor {
  model: string;
  display_name: string;
  support_efforts?: string | string[];
  default_effort?: string;
}

interface QueuedTranscriptEvent {
  hostId: string;
  generation: number;
  sessionId: string;
  event: KimiEventEnvelope;
}

interface SessionCursor {
  sequence: number;
  epoch: string | null;
}

const relay = new BrowserRelay();
const LazyArchiveManager = lazy(() =>
  import("./ArchiveManager.js").then(({ ArchiveManager }) => ({
    default: ArchiveManager,
  })),
);
const LazyTerminalPanel = lazy(() =>
  import("./TerminalPanel.js").then(({ TerminalPanel }) => ({
    default: TerminalPanel,
  })),
);
const kimiScopes = [
  "sessions.list",
  "sessions.create",
  "sessions.read",
  "sessions.archive",
  "sessions.restore",
  "sessions.fork",
  "sessions.prompt",
  "sessions.interrupt",
  "sessions.snapshot",
  "sessions.events",
  "sessions.transcript.read",
  "sessions.transcript.resume",
  "sessions.transcript.subscribe",
  "sessions.messages.page",
  "sessions.prompts.list",
  "sessions.prompts.steer",
  "sessions.prompts.abort",
  "sessions.skills.list",
  "sessions.skills.activate",
  "sessions.commands.list",
  "sessions.commands.execute",
  "sessions.attachments.upload",
  "sessions.media.read",
  "sessions.models.list",
  "sessions.compact",
  "sessions.undo",
  "sessions.btw",
  "sessions.title.write",
  "sessions.tasks.cancel",
  "sessions.tasks.detach",
  "sessions.export",
  "sessions.approvals.respond",
  "sessions.questions.respond",
  "sessions.questions.dismiss",
  "sessions.tasks.list",
  "sessions.files.search",
  "sessions.files.read",
  "sessions.files.status",
  "sessions.permission.read",
  "sessions.permission.write",
  "workspaces.list",
  "workspaces.ensure",
  "oauth.userinfo",
  "oauth.usage",
  "oauth.device.start",
  "oauth.device.poll",
] as const;

function usePreferredTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("aialra-theme");
    if (saved === "light" || saved === "dark") return saved;
    return matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("aialra-theme", theme);
  }, [theme]);
  return [theme, setTheme] as const;
}

function relativeTime(value: string | null): string {
  if (!value) return "从未";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value || "刚刚";
  const minutes = Math.max(0, Math.floor((Date.now() - parsed) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
}

function loginStateText(value: HostDescriptor["loginState"]): string {
  return value === "authenticated"
    ? "Kimi 已登录"
    : value === "unauthenticated"
      ? "Kimi 未登录"
      : "Kimi 登录状态未知";
}

function messageTime(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? new Date(parsed).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : value || "刚刚";
}

function hostIcon(host: HostDescriptor) {
  return host.mode === "vps" ? Server : Laptop;
}

const capabilityDescriptions: Record<string, string> = {
  websocket: "通过加密 WebSocket 接收实时会话事件",
  transcript_v2: "支持按序号恢复完整对话时间线",
  elevation: "支持一次性管理员终端，需要重新验证",
  terminal: "支持普通终端输入、输出和调整尺寸",
  attachments: "支持文件、图片和视频附件",
  archive: "支持归档和恢复会话",
};

function capabilityLabel(value: string): string {
  return (
    {
      websocket: "实时通道",
      transcript_v2: "对话恢复",
      elevation: "管理员终端",
      terminal: "普通终端",
      attachments: "附件",
      archive: "归档恢复",
    }[value] ?? value
  );
}

function preferredHostId(hosts: HostDescriptor[], current: string): string {
  if (hosts.some((host) => host.hostId === current)) return current;
  const saved = localStorage.getItem("aialra-selected-host");
  if (saved && hosts.some((host) => host.hostId === saved)) return saved;
  return (
    (
      hosts.find((host) => host.mode === "vps" && host.state === "online") ??
      hosts.find((host) => host.mode === "vps") ??
      hosts.find((host) => host.state === "online") ??
      hosts[0]
    )?.hostId ?? ""
  );
}

function matchesPermission(value: string): value is PermissionMode {
  return value === "manual" || value === "auto" || value === "yolo";
}

function loadPinnedSessions(): Set<string> {
  try {
    const value = JSON.parse(
      localStorage.getItem("aialra-pinned-sessions") ?? "[]",
    );
    return new Set(
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function waitFor(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export default function App() {
  const demo =
    import.meta.env.VITE_DEMO_MODE === "1" ||
    new URLSearchParams(location.search).get("demo") === "1";
  const [theme, setTheme] = usePreferredTheme();
  const [hosts, setHosts] = useState<HostDescriptor[]>(demo ? demoHosts : []);
  const [hostsPhase, setHostsPhase] = useState<LoadPhase>(
    demo ? "ready" : "loading",
  );
  const [hostId, setHostId] = useState(demo ? demoHosts[0]!.hostId : "");
  const [sessions, setSessions] = useState<UiSession[]>(
    demo ? demoSessions : [],
  );
  const [sessionsPhase, setSessionsPhase] = useState<LoadPhase>(
    demo ? "ready" : "loading",
  );
  const [archivedSessions, setArchivedSessions] = useState<UiSession[]>([]);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [sessionId, setSessionId] = useState(
    demo ? demoSessions[0]!.upstreamSessionId : "",
  );
  const [messages, setMessages] = useState<UiMessage[]>(
    demo ? demoMessages : [],
  );
  const [transcript, setTranscript] = useState<TranscriptState | null>(null);
  const [transcriptSessionId, setTranscriptSessionId] = useState("");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const conversationMessages = useMemo(
    () => coalesceToolMessages(messages),
    [messages],
  );
  const [usage, setUsage] = useState<UsageSnapshot | null>(
    demo ? demoUsage : null,
  );
  const [sessionStatus, setSessionStatus] = useState<UiSessionStatus | null>(
    demo
      ? {
          busy: true,
          contextTokens: 68_000,
          maxContextTokens: 164_000,
          contextUsage: 0.41,
          model: "kimi-code",
          thinkingLevel: "high",
        }
      : null,
  );
  const [tasks, setTasks] = useState<UiTask[]>([]);
  const [approvals, setApprovals] = useState<
    UiSessionSnapshot["pendingApprovals"]
  >([]);
  const [questions, setQuestions] = useState<
    UiSessionSnapshot["pendingQuestions"]
  >([]);
  const [files, setFiles] = useState<UiFileEntry[]>([]);
  const [fileChanges, setFileChanges] = useState<Record<string, string>>({});
  const [filePreview, setFilePreview] = useState<UiFileRead | null>(null);
  const [lastSequence, setLastSequence] = useState(0);
  const [view, setView] = useState<MainView>("conversation");
  const [channel, setChannel] = useState<RelayChannel | null>(null);
  const [terminalChannel, setTerminalChannel] = useState<RelayChannel | null>(
    null,
  );
  const [terminalOutput, setTerminalOutput] = useState<{
    id: number;
    data: string;
  } | null>(null);
  const [terminalExit, setTerminalExit] = useState<{
    reason: string;
    exitCode: number | null;
  } | null>(null);
  const [status, setStatus] = useState(demo ? "合成预览" : "正在连接");
  const [query, setQuery] = useState("");
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [optimisticMessage, setOptimisticMessage] = useState<UiMessage | null>(
    null,
  );
  const [modelOptions, setModelOptions] = useState<ModelDescriptor[]>([]);
  const [selectedModel, setSelectedModel] = useState(demo ? "kimi-code" : "");
  const [thinkingLevel, setThinkingLevel] = useState(demo ? "high" : "");
  const [planMode, setPlanMode] = useState(false);
  const [commands, setCommands] =
    useState<CommandDescriptor[]>(BUILTIN_COMMANDS);
  const [commandSelection, setCommandSelection] = useState(0);
  const [fileSelection, setFileSelection] = useState(0);
  const [mobileNav, setMobileNav] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("aialra-sidebar-collapsed") === "1",
  );
  const [rightPanel, setRightPanel] = useState(() =>
    typeof window === "undefined" ? true : window.innerWidth > 1120,
  );
  const [elevated, setElevated] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [workspaceOptions, setWorkspaceOptions] = useState<WorkspaceOption[]>(
    [],
  );
  const [workspaceMissing, setWorkspaceMissing] = useState(false);
  const [renameTarget, setRenameTarget] = useState<UiSession | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [pairingOpen, setPairingOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [oauthFlow, setOauthFlow] = useState<OAuthFlow | null>(null);
  const [oauthRegion, setOauthRegion] =
    useState<KimiOAuthRegion>("mainland-cn");
  const [newSessionDefault, setNewSessionDefault] =
    useState<PermissionMode>("manual");
  const [reconnectGeneration, setReconnectGeneration] = useState(0);
  const [terminalGeneration, setTerminalGeneration] = useState(0);
  const [terminalPhase, setTerminalPhase] = useState<TerminalPhase>(
    demo ? "ready" : "loading",
  );
  const composer = useRef<HTMLTextAreaElement>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const channelRef = useRef<RelayChannel | null>(null);
  const hostsRef = useRef(hosts);
  const hostGenerationRef = useRef(0);
  const sessionsByHostRef = useRef(new Map<string, UiSession[]>());
  const sessionSelectionByHostRef = useRef(new Map<string, string>());
  const activeSessionRef = useRef(sessionId);
  const messagesRef = useRef(messages);
  const transcriptRef = useRef<TranscriptState | null>(transcript);
  const transcriptSessionIdRef = useRef(transcriptSessionId);
  const transcriptEventQueueRef = useRef<QueuedTranscriptEvent[]>([]);
  const transcriptFlushFrameRef = useRef<number | null>(null);
  const cursorRef = useRef(new Map<string, SessionCursor>());
  const refreshTimer = useRef<number | null>(null);
  const refreshGenerationRef = useRef(0);
  const oauthTimer = useRef<number | null>(null);
  const oauthHostRef = useRef<string | null>(null);
  const oauthFlowRef = useRef<OAuthFlow | null>(oauthFlow);
  const connectedHostRef = useRef<string | null>(null);
  const reconnectAttemptRef = useRef(0);
  const browserReconnectTimer = useRef<number | null>(null);
  const terminalReconnectTimer = useRef<number | null>(null);
  const transcriptRetryAttemptRef = useRef(0);
  const transcriptRetryTimer = useRef<number | null>(null);
  const sendRequestRef = useRef(0);
  const composerDraftRef = useRef(
    new Map<string, { model: string; thinkingLevel: string }>(),
  );
  const [pinnedSessionIds, setPinnedSessionIds] =
    useState<Set<string>>(loadPinnedSessions);
  const [archiveQuery, setArchiveQuery] = useState("");
  const pendingWorkspaceSessionRef = useRef<NewSessionInput | null>(null);
  const [promptActions, setPromptActions] = useState<
    Record<string, PromptActionState>
  >({});
  const promptActionLocksRef = useRef(new Set<string>());
  const retryPromptRef = useRef<{
    hostId: string;
    sessionId: string;
    promptId: string;
    text: string;
    attachmentIds: string[];
  } | null>(null);
  const [autoCollapsedTurnIds, setAutoCollapsedTurnIds] = useState<Set<string>>(
    () => new Set(),
  );
  const conversationScrollRef = useRef<HTMLDivElement | null>(null);
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);
  const followBottomRef = useRef(true);
  const [followingBottom, setFollowingBottom] = useState(true);
  const [unreadWhileScrolled, setUnreadWhileScrolled] = useState(0);
  const scrollFrameRef = useRef<number | null>(null);

  const host = hosts.find((candidate) => candidate.hostId === hostId);
  const session = sessions.find(
    (candidate) => candidate.upstreamSessionId === sessionId,
  );
  const filteredSessions = useMemo(
    () =>
      sessions.filter((item) =>
        `${item.title} ${item.workspaceAlias}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [query, sessions],
  );
  const projectGroups = useMemo(() => {
    const groups = new Map<string, UiSession[]>();
    for (const item of filteredSessions) {
      const project = item.workspaceAlias || "未命名项目";
      const group = groups.get(project) ?? [];
      group.push(item);
      groups.set(project, group);
    }
    return [...groups.entries()]
      .map(([project, items]) => ({
        project,
        items: [...items].sort((left, right) => {
          const leftPinned = pinnedSessionIds.has(left.upstreamSessionId)
            ? 1
            : 0;
          const rightPinned = pinnedSessionIds.has(right.upstreamSessionId)
            ? 1
            : 0;
          if (leftPinned !== rightPinned) return rightPinned - leftPinned;
          return (
            Date.parse(right.updatedAt ?? "") - Date.parse(left.updatedAt ?? "")
          );
        }),
      }))
      .sort((left, right) =>
        left.project.localeCompare(right.project, "zh-CN"),
      );
  }, [filteredSessions, pinnedSessionIds]);
  const promptQueue = useMemo(
    () =>
      transcript
        ? [...transcript.prompts.values()].filter((item) =>
            ["running", "queued", "blocked"].includes(String(item.status)),
          )
        : [],
    [transcript],
  );
  const transcriptVisible = shouldRenderTranscript(
    transcript,
    transcriptSessionId,
    session?.upstreamSessionId ?? "",
    conversationMessages.length,
  );
  const channelReady = isHostChannelReady(host, Boolean(channel), demo);
  const canUseComposerAttachments = Boolean(session && channelReady);

  useEffect(() => {
    activeSessionRef.current = sessionId;
    if (hostId) sessionSelectionByHostRef.current.set(hostId, sessionId);
  }, [hostId, sessionId]);

  useEffect(() => {
    hostsRef.current = hosts;
    for (const host of hosts) {
      if (!sessionsByHostRef.current.has(host.hostId))
        sessionsByHostRef.current.set(host.hostId, []);
    }
  }, [hosts]);

  useEffect(() => {
    if (demo) return;
    return relay.subscribeHostStatus((update: HostStatusUpdate) => {
      setHosts((current) =>
        current.map((item) =>
          item.hostId === update.hostId
            ? {
                ...item,
                state: update.state,
                loginState: update.loginState,
                kimiVersion: update.kimiVersion,
                lastSeenAt: new Date().toISOString(),
              }
            : item,
        ),
      );
    });
  }, [demo]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (hostId) sessionsByHostRef.current.set(hostId, sessions);
  }, [hostId, sessions]);

  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  useEffect(() => {
    transcriptSessionIdRef.current = transcriptSessionId;
  }, [transcriptSessionId]);

  useEffect(() => {
    oauthFlowRef.current = oauthFlow;
  }, [oauthFlow]);

  useEffect(() => {
    if (demo || !channel || !host || !newSessionOpen) return;
    let active = true;
    const storageKey = `aialra-workspaces:${host.hostId}`;
    let recent: WorkspaceOption[] = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      if (Array.isArray(parsed)) {
        recent = parsed.filter((item): item is WorkspaceOption =>
          Boolean(
            item &&
              typeof item.root === "string" &&
              typeof item.name === "string",
          ),
        );
      }
    } catch {
      recent = [];
    }
    setWorkspaceOptions(recent);
    void channel
      .rpc<{ items?: Array<Record<string, unknown>> }>("workspaces.list")
      .then((result) => {
        if (!active) return;
        const remote = (result.items ?? []).flatMap((item) => {
          const root =
            typeof item.root === "string"
              ? item.root
              : typeof item.path === "string"
                ? item.path
                : "";
          if (!root) return [];
          const name =
            typeof item.name === "string" && item.name.trim()
              ? item.name
              : (root.split(/[\\/]/u).filter(Boolean).at(-1) ?? root);
          return [{ root, name }];
        });
        const merged = [...remote, ...recent].filter(
          (item, index, items) =>
            items.findIndex((candidate) => candidate.root === item.root) ===
            index,
        );
        setWorkspaceOptions(merged.slice(0, 20));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [channel, demo, host?.hostId, newSessionOpen]);

  useEffect(() => {
    if (!newSessionOpen) {
      setWorkspaceMissing(false);
      pendingWorkspaceSessionRef.current = null;
    }
  }, [newSessionOpen]);

  useEffect(() => {
    const container = conversationScrollRef.current;
    if (!container || view !== "conversation") return;
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    const scrollToBottom = () => {
      scrollFrameRef.current = null;
      if (!followBottomRef.current) {
        setUnreadWhileScrolled((count) => count + 1);
        return;
      }
      container.scrollTop = container.scrollHeight;
      bottomAnchorRef.current?.scrollIntoView({ block: "end" });
      setUnreadWhileScrolled(0);
    };
    scrollFrameRef.current = window.requestAnimationFrame(scrollToBottom);
    return () => {
      if (scrollFrameRef.current === null) return;
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    };
  }, [
    conversationMessages,
    optimisticMessage,
    transcript,
    transcriptVisible,
    view,
  ]);

  useEffect(() => {
    followBottomRef.current = true;
    setFollowingBottom(true);
    setUnreadWhileScrolled(0);
    setPromptActions({});
    promptActionLocksRef.current.clear();
    setAutoCollapsedTurnIds(new Set());
    // A draft belongs to the selected session.  Clear it when the user
    // deliberately changes sessions, while reconnects for the same session
    // leave the draft and attachments untouched.
    sendRequestRef.current += 1;
    setSending(false);
    setActionBusy(false);
    setOptimisticMessage(null);
    setPrompt("");
    setAttachments([]);
  }, [hostId, sessionId]);

  function markCompletedTurnsCollapsed() {
    const current = transcriptRef.current;
    if (!current) return;
    const completed = current.items.flatMap((item) =>
      item.kind === "turn" &&
      item.state !== "running" &&
      item.state !== "queued"
        ? [item.turnId]
        : [],
    );
    if (!completed.length) return;
    setAutoCollapsedTurnIds((existing) => {
      const next = new Set(existing);
      for (const turnId of completed) next.add(turnId);
      return next;
    });
  }

  function handleConversationScroll() {
    const container = conversationScrollRef.current;
    if (!container) return;
    const distance =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const nextFollowing = distance <= 64;
    followBottomRef.current = nextFollowing;
    setFollowingBottom(nextFollowing);
    if (nextFollowing) setUnreadWhileScrolled(0);
  }

  function returnToConversationBottom() {
    const container = conversationScrollRef.current;
    if (!container) return;
    followBottomRef.current = true;
    setFollowingBottom(true);
    setUnreadWhileScrolled(0);
    container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
  }

  useEffect(() => {
    if (!optimisticMessage || !transcript) return;
    const sentAt = Date.parse(optimisticMessage.time);
    const matched = transcript.items.some((item) => {
      if (item.kind !== "turn") return false;
      if (item.prompt?.trim() === optimisticMessage.text.trim()) return true;
      const startedAt = Date.parse(item.startedAt ?? "");
      return (
        Number.isFinite(sentAt) &&
        Number.isFinite(startedAt) &&
        startedAt >= sentAt - 1_000
      );
    });
    if (matched) setOptimisticMessage(null);
  }, [optimisticMessage, transcript]);

  useEffect(() => {
    if (!demo && hostId) localStorage.setItem("aialra-selected-host", hostId);
  }, [demo, hostId]);

  useEffect(() => {
    localStorage.setItem(
      "aialra-sidebar-collapsed",
      sidebarCollapsed ? "1" : "0",
    );
  }, [sidebarCollapsed]);

  useEffect(() => {
    localStorage.setItem(
      "aialra-pinned-sessions",
      JSON.stringify([...pinnedSessionIds]),
    );
  }, [pinnedSessionIds]);

  useEffect(() => {
    if (demo) return;
    const url = new URL(location.href);
    if (url.searchParams.get("elevated") === "1") {
      setView("terminal");
      setElevated(true);
      url.searchParams.delete("elevated");
      history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, [demo]);

  useEffect(() => {
    if (!authRequired || demo) return;
    const current = `${location.pathname}${location.search}${location.hash}`;
    location.replace(`/auth/login?returnTo=${encodeURIComponent(current)}`);
  }, [authRequired, demo]);

  useEffect(() => {
    if (demo || !host) return;
    const shouldPoll =
      host.state === "offline" ||
      host.state === "degraded" ||
      sessionsPhase === "reconnecting";
    if (!shouldPoll) return;
    let active = true;
    let timer: number | null = null;
    const poll = async () => {
      try {
        const nextHosts = await api.hosts();
        if (!active) return;
        setHosts(nextHosts);
        setHostsPhase(nextHosts.length ? "ready" : "empty");
        if (nextHosts.some((item) => item.hostId === host.hostId))
          setStatus((current) =>
            current === "离线元数据" || current === "状态异常 · 正在重连"
              ? "等待代理启动"
              : current,
          );
      } catch (nextError) {
        if (active && nextError instanceof ApiError && nextError.status === 401)
          setAuthRequired(true);
      } finally {
        if (active) timer = window.setTimeout(() => void poll(), 5_000);
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [demo, host?.hostId, host?.state, sessionsPhase]);

  useEffect(() => {
    if (host && elevated && !demo && !host.capabilities.includes("elevation")) {
      setElevated(false);
      setError("所选主机没有可用的提权终端代理");
    }
  }, [demo, elevated, host]);

  useEffect(() => {
    if (!host || demo) return;
    let active = true;
    void api
      .hostPreferences(host.hostId)
      .then((preferences) => {
        if (active) {
          setNewSessionDefault(preferences.defaultPermissionMode);
          setPinnedSessionIds(new Set(preferences.pinnedSessionIds));
        }
      })
      .catch((nextError) => {
        if (active)
          setError(
            nextError instanceof Error
              ? nextError.message
              : "读取主机偏好设置失败",
          );
      });
    return () => {
      active = false;
    };
  }, [demo, host?.hostId]);

  useEffect(() => {
    if (demo) return;
    let active = true;
    let ownerChecked = false;
    let inFlight = false;
    async function loadHosts() {
      if (inFlight) return;
      inFlight = true;
      try {
        if (!hostsRef.current.length) setHostsPhase("loading");
        const nextHosts = ownerChecked
          ? await api.hosts()
          : (await Promise.all([api.me(), api.hosts()]))[1];
        ownerChecked = true;
        if (!active) return;
        setHosts((current) =>
          sameHosts(current, nextHosts) ? current : nextHosts,
        );
        setHostsPhase(nextHosts.length ? "ready" : "empty");
        if (!nextHosts.length) setSessionsPhase("empty");
        setHostId((current) => preferredHostId(nextHosts, current));
        setStatus(
          nextHosts.length
            ? channelRef.current
              ? "在线 · 端到端加密"
              : "就绪"
            : "尚未配对主机",
        );
      } catch (nextError) {
        if (active)
          setHostsPhase(hostsRef.current.length ? "reconnecting" : "error");
        if (nextError instanceof ApiError && nextError.status === 401)
          setAuthRequired(true);
        else
          setError(
            nextError instanceof Error ? nextError.message : "控制平面不可用",
          );
      } finally {
        inFlight = false;
      }
    }
    void loadHosts();
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadHosts();
    };
    const onFocus = () => void loadHosts();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => void loadHosts(), 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [demo]);

  useEffect(() => {
    if (demo || !host) return;
    const generation = ++hostGenerationRef.current;
    let disposed = false;
    let opened: RelayChannel | null = null;
    const abortController = new AbortController();
    const changingHost = connectedHostRef.current !== host.hostId;
    connectedHostRef.current = host.hostId;
    clearRefreshTimer();
    clearTranscriptRetry();
    if (changingHost) clearBrowserReconnectTimer();
    channelRef.current?.close();
    channelRef.current = null;
    setChannel(null);
    setActionBusy(false);
    if (changingHost) {
      const cachedSessions = sessionsByHostRef.current.get(host.hostId) ?? [];
      const cachedSelection = sessionSelectionByHostRef.current.get(
        host.hostId,
      );
      setSessions(cachedSessions);
      setSessionId(
        cachedSelection &&
          cachedSessions.some(
            (item) => item.upstreamSessionId === cachedSelection,
          )
          ? cachedSelection
          : (cachedSessions[0]?.upstreamSessionId ?? ""),
      );
      setMessages([]);
      setOptimisticMessage(null);
      transcriptRef.current = null;
      setTranscript(null);
      transcriptSessionIdRef.current = "";
      setTranscriptSessionId("");
      setTasks([]);
      setApprovals([]);
      setQuestions([]);
      setFiles([]);
      setFileChanges({});
      setFilePreview(null);
      setUsage(null);
      setOauthFlow(null);
      setError(null);
      setPrompt("");
      setAttachments([]);
      reconnectAttemptRef.current = 0;
      oauthHostRef.current = null;
      clearOAuthTimer();
      oauthFlowRef.current = null;
    }
    setSessionsPhase(changingHost ? "loading" : "reconnecting");
    setStatus("等待代理启动");
    void (async () => {
      try {
        if (host.state === "offline" || host.state === "unsupported") {
          const cached = await api.sessionCache(host.hostId);
          if (!disposed && hostGenerationRef.current === generation) {
            const cachedSessions = cached.map((item) => ({
              ...item,
              permissionMode: "manual" as PermissionMode,
            }));
            const previousSessions =
              sessionsByHostRef.current.get(host.hostId) ?? [];
            const merged = [
              ...previousSessions,
              ...cachedSessions.filter(
                (item) =>
                  !previousSessions.some(
                    (candidate) =>
                      candidate.upstreamSessionId === item.upstreamSessionId,
                  ),
              ),
            ];
            sessionsByHostRef.current.set(host.hostId, merged);
            setSessions(merged);
            const previousSelection = sessionSelectionByHostRef.current.get(
              host.hostId,
            );
            const nextSelection =
              previousSelection &&
              merged.some(
                (item) => item.upstreamSessionId === previousSelection,
              )
                ? previousSelection
                : (merged[0]?.upstreamSessionId ?? "");
            setSessionId(nextSelection);
            setSessionsPhase(host.state === "offline" ? "offline" : "error");
            setStatus(
              host.state === "offline" ? "离线元数据" : "不支持的 Kimi 版本",
            );
          }
          return;
        }
        opened = await relay.open(
          host.hostId,
          "kimi",
          [...kimiScopes],
          (raw) => handleAgentEvent(raw, host.hostId, generation),
          abortController.signal,
        );
        if (
          disposed ||
          abortController.signal.aborted ||
          hostGenerationRef.current !== generation
        )
          return opened.close();
        channelRef.current = opened;
        setChannel(opened);
        setHosts((current) =>
          current.map((item) =>
            item.hostId === host.hostId ? { ...item, state: "online" } : item,
          ),
        );
        setError(null);
        setStatus("在线 · 端到端加密");
        reconnectAttemptRef.current = 0;
        const pendingOAuth = oauthFlowRef.current;
        if (
          !changingHost &&
          oauthHostRef.current === host.hostId &&
          pendingOAuth?.status === "pending"
        ) {
          clearOAuthTimer();
          scheduleOAuthPoll(pendingOAuth, opened, host.hostId, generation);
        }
        const sessionResult = await opened.rpc<{ sessions: UiSession[] }>(
          "sessions.list",
        );
        if (
          disposed ||
          abortController.signal.aborted ||
          hostGenerationRef.current !== generation
        )
          return;
        sessionsByHostRef.current.set(host.hostId, sessionResult.sessions);
        setSessions(sessionResult.sessions);
        setSessionsPhase(sessionResult.sessions.length ? "ready" : "empty");
        setSessionId((current) =>
          sessionResult.sessions.some(
            (item) => item.upstreamSessionId === current,
          )
            ? current
            : (sessionResult.sessions[0]?.upstreamSessionId ?? ""),
        );
        void opened
          .rpc<UsageSnapshot>("oauth.usage")
          .then((snapshot) => {
            if (
              !disposed &&
              !abortController.signal.aborted &&
              channelRef.current === opened &&
              hostGenerationRef.current === generation
            )
              setUsage(snapshot);
          })
          .catch(() => undefined);
      } catch (nextError) {
        if (
          !disposed &&
          !abortController.signal.aborted &&
          hostGenerationRef.current === generation
        ) {
          if (nextError instanceof ApiError && nextError.status === 401) {
            setAuthRequired(true);
            return;
          }
          if (isKimiAuthenticationError(nextError)) {
            setHosts((current) =>
              current.map((item) =>
                item.hostId === host.hostId
                  ? { ...item, loginState: "unauthenticated" }
                  : item,
              ),
            );
            setSessionsPhase("empty");
            setStatus("在线 · Kimi 未登录");
            setError(
              kimiErrorText(
                nextError instanceof Error
                  ? nextError.message
                  : "Kimi 账号未登录",
              ),
            );
            return;
          }
          setError(
            nextError instanceof Error
              ? kimiErrorText(nextError.message)
              : "主机通道连接失败",
          );
          setSessionsPhase(
            host.state === "offline" ? "offline" : "reconnecting",
          );
          setStatus("状态异常 · 正在重连");
          scheduleBrowserReconnect();
        }
      }
    })();
    return () => {
      disposed = true;
      abortController.abort();
      opened?.close();
      if (channelRef.current === opened) channelRef.current = null;
    };
    // Host changes and relay failures intentionally replace the encrypted channel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, host?.hostId, host?.state, reconnectGeneration]);

  useEffect(() => {
    if (demo || !channel || !sessionId) return;
    if (transcriptRetryTimer.current !== null) {
      window.clearTimeout(transcriptRetryTimer.current);
      transcriptRetryTimer.current = null;
    }
    transcriptRetryAttemptRef.current = 0;
    void refreshSession(sessionId, channel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, demo, sessionId]);

  useEffect(() => {
    if (demo || !channel || !sessionId) return;
    if (
      !Object.values(promptActions).some(
        (state) => state === "pending-confirmation",
      )
    )
      return;
    void verifyPendingPromptActions(channel, sessionId);
    // A new encrypted channel is the only safe trigger for read-only confirmation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, demo, sessionId]);

  useEffect(() => {
    if (!modelOptions.length || !sessionId) return;
    const scopedSessionKey = hostSessionKey(hostId, sessionId);
    const draft = composerDraftRef.current.get(scopedSessionKey);
    const currentModel = draft?.model || selectedModel;
    const validModel = modelOptions.some((item) => item.model === currentModel)
      ? currentModel
      : (modelOptions[0]?.model ?? "");
    if (validModel && validModel !== selectedModel)
      setSelectedModel(validModel);
    const descriptor = modelOptions.find((item) => item.model === validModel);
    const efforts = supportedEfforts(descriptor?.support_efforts);
    if (thinkingLevel && !efforts.includes(thinkingLevel)) {
      setThinkingLevel("");
      composerDraftRef.current.set(scopedSessionKey, {
        model: validModel,
        thinkingLevel: "",
      });
    }
  }, [hostId, modelOptions, selectedModel, sessionId, thinkingLevel]);

  useEffect(() => {
    if (demo || !channel || !host || view !== "archive") return;
    let active = true;
    setArchiveLoading(true);
    void channel
      .rpc<{ sessions: UiSession[] }>("sessions.list", {
        includeArchived: true,
        archivedOnly: true,
        pageSize: 100,
      })
      .then((result) => {
        if (active) setArchivedSessions(result.sessions ?? []);
      })
      .catch((nextError) => {
        if (active)
          setError(
            nextError instanceof Error ? nextError.message : "加载归档对话失败",
          );
      })
      .finally(() => {
        if (active) setArchiveLoading(false);
      });
    return () => {
      active = false;
    };
  }, [channel, demo, host?.hostId, view]);

  useEffect(() => {
    if (demo || !channel || !sessionId) return;
    const reconcileWhenVisible = () => {
      if (document.visibilityState === "visible")
        void reconcileTranscript(sessionId);
    };
    document.addEventListener("visibilitychange", reconcileWhenVisible);
    return () =>
      document.removeEventListener("visibilitychange", reconcileWhenVisible);
    // Visibility recovery always targets the current encrypted channel and session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, demo, sessionId]);

  useEffect(() => {
    if (demo || !channel || !sessionId) return;
    let active = true;
    void Promise.all([
      channel.rpc<{
        builtins: CommandDescriptor[];
        skills: Array<Record<string, unknown>>;
      }>("sessions.commands.list", { sessionId }),
      channel
        .rpc<{
          items: ModelDescriptor[];
        }>("sessions.models.list", { sessionId })
        .catch(() => ({ items: [] })),
    ])
      .then(([result, models]) => {
        if (!active) return;
        const skills = (result.skills ?? []).flatMap((skill) => {
          const name =
            typeof skill.name === "string"
              ? skill.name
              : typeof skill.skill_name === "string"
                ? skill.skill_name
                : null;
          if (!name) return [];
          return [
            {
              name,
              skillName: name,
              kind: "skill" as const,
              description:
                typeof skill.description === "string"
                  ? skill.description
                  : "激活目标主机技能",
              busy: true,
              argumentHint: "参数",
            },
          ];
        });
        setCommands(mergeCommands(result.builtins ?? [], skills));
        setModelOptions(models.items ?? []);
      })
      .catch(() => setCommands(BUILTIN_COMMANDS));
    return () => {
      active = false;
    };
  }, [channel, demo, sessionId]);

  useEffect(() => {
    if (demo) {
      clearTerminalReconnectTimer();
      setTerminalExit(null);
      setTerminalPhase(view === "terminal" ? "ready" : "offline");
      return;
    }
    if (view !== "terminal" || !host) {
      clearTerminalReconnectTimer();
      setTerminalPhase("offline");
      return;
    }
    if (host.state !== "online") {
      clearTerminalReconnectTimer();
      terminalChannel?.close();
      setTerminalChannel(null);
      setTerminalOutput(null);
      setTerminalExit(null);
      setTerminalPhase("offline");
      return;
    }
    let disposed = false;
    let opened: RelayChannel | null = null;
    const abortController = new AbortController();
    const targetHostId = host.hostId;
    const targetHostGeneration = hostGenerationRef.current;
    const targetTerminalGeneration = terminalGeneration;
    const scheduleTerminalReconnect = () => {
      if (terminalReconnectTimer.current !== null) return;
      terminalReconnectTimer.current = window.setTimeout(() => {
        terminalReconnectTimer.current = null;
        if (
          !disposed &&
          view === "terminal" &&
          host?.hostId === targetHostId &&
          hostGenerationRef.current === targetHostGeneration &&
          terminalGeneration === targetTerminalGeneration
        )
          setTerminalGeneration((generation) => generation + 1);
      }, 1_500);
    };
    clearTerminalReconnectTimer();
    setTerminalExit(null);
    setTerminalPhase(terminalChannel ? "reconnecting" : "loading");
    terminalChannel?.close();
    void relay
      .open(
        host.hostId,
        elevated ? "elevated-terminal" : "terminal",
        elevated
          ? [
              "terminal.elevate.open",
              "terminal.elevate.input",
              "terminal.resize",
              "terminal.close",
            ]
          : [
              "terminal.open",
              "terminal.resume",
              "terminal.input",
              "terminal.resize",
              "terminal.close",
            ],
        (event) => {
          const value =
            event && typeof event === "object"
              ? (event as {
                  type?: string;
                  data?: unknown;
                  reason?: unknown;
                  exitCode?: unknown;
                })
              : null;
          if (
            value?.type === "terminal.output" &&
            typeof value.data === "string"
          ) {
            setTerminalOutput((current) => ({
              id: (current?.id ?? 0) + 1,
              data: value.data as string,
            }));
          } else if (value?.type === "terminal.exit" && !disposed) {
            setTerminalExit({
              reason:
                typeof value.reason === "string" ? value.reason : "exited",
              exitCode:
                typeof value.exitCode === "number" ? value.exitCode : null,
            });
            setTerminalPhase("ready");
          } else if (value?.type === "channel.disconnected" && !disposed) {
            setTerminalPhase("reconnecting");
            scheduleTerminalReconnect();
          }
        },
        abortController.signal,
      )
      .then((nextChannel) => {
        opened = nextChannel;
        if (
          disposed ||
          hostGenerationRef.current !== targetHostGeneration ||
          host?.hostId !== targetHostId
        )
          nextChannel.close();
        else {
          setTerminalChannel(nextChannel);
          setTerminalPhase("ready");
        }
      })
      .catch((nextError: unknown) => {
        if (
          !disposed &&
          hostGenerationRef.current === targetHostGeneration &&
          host?.hostId === targetHostId
        ) {
          setTerminalPhase("error");
          setError(
            nextError instanceof Error ? nextError.message : "终端连接失败",
          );
          scheduleTerminalReconnect();
        }
      });
    return () => {
      disposed = true;
      abortController.abort();
      opened?.close();
      clearTerminalReconnectTimer();
      setTerminalChannel(null);
      if (view === "terminal") setTerminalPhase("reconnecting");
    };
    // Terminal mode switches and relay failures require a fresh encrypted channel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, elevated, host?.hostId, host?.state, view, terminalGeneration]);

  useEffect(
    () => () => {
      clearRefreshTimer();
      clearOAuthTimer();
      clearBrowserReconnectTimer();
      clearTerminalReconnectTimer();
      clearTranscriptRetry();
      if (transcriptFlushFrameRef.current !== null) {
        if (typeof window.cancelAnimationFrame === "function")
          window.cancelAnimationFrame(transcriptFlushFrameRef.current);
        else window.clearTimeout(transcriptFlushFrameRef.current);
      }
      transcriptFlushFrameRef.current = null;
      transcriptEventQueueRef.current = [];
    },
    [],
  );

  function handleAgentEvent(
    raw: unknown,
    eventHostId = connectedHostRef.current ?? hostId,
    eventGeneration = hostGenerationRef.current,
  ) {
    const event = decodeKimiEvent(raw);
    if (!event) return;
    if (
      !eventHostId ||
      eventHostId !== connectedHostRef.current ||
      eventGeneration !== hostGenerationRef.current
    )
      return;
    if (event.type === "channel.disconnected") {
      channelRef.current = null;
      setChannel(null);
      setStatus("正在重连");
      scheduleBrowserReconnect();
      return;
    }
    const selected = activeSessionRef.current;
    if (event.type === "transcript.reset") {
      queueTranscriptEvent(event, eventHostId, eventGeneration);
      return;
    }
    if (event.type === "transcript.ops") {
      queueTranscriptEvent(event, eventHostId, eventGeneration);
      return;
    }
    if (event.type === "resync_required") {
      const target =
        typeof event.payload.session_id === "string"
          ? event.payload.session_id
          : event.sessionId;
      if (target === selected) void refreshSession(selected);
      return;
    }
    if (event.sessionId && event.sessionId !== selected) {
      if (
        event.type === "event.session.work_changed" ||
        event.type === "session.meta.updated"
      )
        scheduleSessionListRefresh();
      return;
    }
    const cursorKey = hostSessionKey(eventHostId, selected);
    const cursor = cursorRef.current.get(cursorKey)?.sequence ?? 0;
    if (!shouldApplySequence(cursor, event.sequence)) return;
    if (event.sequence !== null) {
      const currentCursor = cursorRef.current.get(cursorKey);
      cursorRef.current.set(cursorKey, {
        sequence: event.sequence,
        epoch: currentCursor?.epoch ?? null,
      });
      setLastSequence(event.sequence);
    }
    const turnId =
      typeof event.payload.turnId === "number" ? event.payload.turnId : 0;
    if (
      event.type === "assistant.delta" &&
      typeof event.payload.delta === "string"
    ) {
      setMessages((current) =>
        appendAssistantDelta(
          current,
          turnId,
          event.payload.delta as string,
          event.timestamp ?? "",
        ),
      );
      setSessionStatus((current) =>
        current ? { ...current, busy: true } : current,
      );
      return;
    }
    if (event.type === "tool.call.started") {
      const callId = String(event.payload.toolCallId ?? crypto.randomUUID());
      setMessages((current) => [
        ...current.filter((item) => item.id !== `live-tool:${callId}`),
        {
          id: `live-tool:${callId}`,
          role: "tool",
          toolCallId: callId,
          toolName: String(event.payload.name ?? "tool"),
          text: String(
            event.payload.description ??
              displayEventValue(event.payload.display ?? event.payload.args),
          ),
          toolInput: String(
            event.payload.description ??
              displayEventValue(event.payload.display ?? event.payload.args),
          ),
          time: event.timestamp ?? "",
          streaming: true,
        },
      ]);
      return;
    }
    if (event.type === "tool.progress") {
      const callId = String(event.payload.toolCallId ?? "");
      const update = event.payload.update as
        | Record<string, unknown>
        | undefined;
      if (callId && typeof update?.text === "string")
        setMessages((current) =>
          current.map((item) =>
            item.id === `live-tool:${callId}`
              ? { ...item, toolOutput: update.text as string }
              : item,
          ),
        );
      return;
    }
    if (event.type === "tool.result") {
      const callId = String(event.payload.toolCallId ?? "");
      setMessages((current) =>
        current.map((item) =>
          item.id === `live-tool:${callId}`
            ? {
                ...item,
                toolOutput: displayEventValue(event.payload.output),
                streaming: false,
                isError: Boolean(event.payload.isError),
              }
            : item,
        ),
      );
      scheduleRefresh();
      return;
    }
    if (event.type === "turn.started") {
      setSessionStatus((current) =>
        current ? { ...current, busy: true } : current,
      );
      setSessions((current) =>
        current.map((item) =>
          item.upstreamSessionId === selected
            ? { ...item, state: "running" }
            : item,
        ),
      );
      return;
    }
    if (event.type === "turn.ended") {
      setMessages((current) => finishAssistantTurn(current, turnId));
      setSessionStatus((current) =>
        current ? { ...current, busy: false } : current,
      );
      const failure = turnFailureMessage(event.payload);
      if (failure) setError(failure);
      scheduleRefresh();
      return;
    }
    if (event.type === "agent.status.updated") {
      setSessionStatus((current) => ({
        busy: current?.busy ?? false,
        contextTokens:
          typeof event.payload.contextTokens === "number"
            ? event.payload.contextTokens
            : (current?.contextTokens ?? 0),
        maxContextTokens:
          typeof event.payload.maxContextTokens === "number"
            ? event.payload.maxContextTokens
            : (current?.maxContextTokens ?? null),
        contextUsage:
          typeof event.payload.contextUsage === "number"
            ? event.payload.contextUsage
            : (current?.contextUsage ?? null),
        model:
          typeof event.payload.model === "string"
            ? event.payload.model
            : (current?.model ?? null),
        thinkingLevel:
          typeof event.payload.thinkingEffort === "string"
            ? event.payload.thinkingEffort
            : (current?.thinkingLevel ?? ""),
      }));
      if (typeof event.payload.permission === "string") {
        const permission = event.payload.permission as PermissionMode;
        setSessions((current) =>
          current.map((item) =>
            item.upstreamSessionId === selected
              ? { ...item, permissionMode: permission }
              : item,
          ),
        );
      }
      return;
    }
    if (event.type === "error") {
      setError(
        kimiErrorText(String(event.payload.message ?? "Kimi 返回了错误")),
      );
      scheduleRefresh();
      return;
    }
    if (
      /^(event\.approval|event\.question|task\.|background\.task\.|event\.session\.work_changed|session\.meta\.updated|prompt\.)/u.test(
        event.type,
      )
    )
      scheduleRefresh();
  }

  function queueTranscriptEvent(
    event: KimiEventEnvelope,
    eventHostId = connectedHostRef.current ?? hostId,
    eventGeneration = hostGenerationRef.current,
  ) {
    if (
      !eventHostId ||
      event.sessionId !== activeSessionRef.current ||
      eventGeneration !== hostGenerationRef.current
    )
      return;
    transcriptEventQueueRef.current.push({
      hostId: eventHostId,
      generation: eventGeneration,
      sessionId: activeSessionRef.current,
      event,
    });
    if (transcriptFlushFrameRef.current !== null) return;
    const flush = () => {
      transcriptFlushFrameRef.current = null;
      flushTranscriptEvents();
    };
    if (typeof window.requestAnimationFrame === "function")
      transcriptFlushFrameRef.current = window.requestAnimationFrame(flush);
    else
      transcriptFlushFrameRef.current = window.setTimeout(
        flush,
        16,
      ) as unknown as number;
  }

  function flushTranscriptEvents() {
    const selected = activeSessionRef.current;
    const selectedHostId = connectedHostRef.current ?? hostId;
    const selectedGeneration = hostGenerationRef.current;
    const events = transcriptEventQueueRef.current.splice(0);
    if (events.length === 0) return;
    let next =
      transcriptRef.current && transcriptSessionIdRef.current === selected
        ? transcriptRef.current
        : null;
    let nextSessionId = transcriptSessionIdRef.current;
    let needsReconcile = false;
    for (const event of events) {
      if (
        event.hostId !== selectedHostId ||
        event.generation !== selectedGeneration ||
        event.sessionId !== selected
      )
        continue;
      const value = event.event;
      if (value.type === "transcript.reset") {
        const snapshot = value.payload.snapshot as
          | Record<string, unknown>
          | undefined;
        if (!snapshot) continue;
        const page: TranscriptPage = {
          agent_id: String(value.payload.agent_id ?? "main"),
          items: (snapshot.items as TranscriptPage["items"]) ?? [],
          has_more: Boolean(value.payload.has_more_older),
          tasks: (snapshot.tasks as TranscriptPage["tasks"]) ?? [],
          interactions: (snapshot.interactions as unknown[]) ?? [],
          attachments:
            (snapshot.attachments as TranscriptPage["attachments"]) ?? [],
          todos: (snapshot.todos as TranscriptPage["todos"]) ?? [],
          prompts: (snapshot.prompts as TranscriptPage["prompts"]) ?? [],
          meta: (snapshot.meta as Record<string, unknown>) ?? {},
          agents: [],
          pending_interactions: [],
          ...(typeof value.payload.seq === "number"
            ? { seq: value.payload.seq }
            : {}),
        };
        next = applyTranscriptReset(next, page);
        nextSessionId = selected;
        continue;
      }
      const operations = Array.isArray(value.payload.ops)
        ? (value.payload.ops as TranscriptOperation[])
        : [];
      const sequence =
        typeof value.payload.seq === "number" ? value.payload.seq : undefined;
      const base =
        next ?? emptyTranscript(String(value.payload.agent_id ?? "main"));
      const result = applyTranscriptOps(base, operations, sequence);
      next = result.state;
      nextSessionId = selected;
      needsReconcile ||= result.gap;
    }
    if (next && nextSessionId === selected) {
      transcriptRef.current = next;
      transcriptSessionIdRef.current = selected;
      setTranscript(next);
      setTranscriptSessionId(selected);
    }
    if (needsReconcile)
      window.setTimeout(() => {
        if (
          connectedHostRef.current === selectedHostId &&
          hostGenerationRef.current === selectedGeneration &&
          activeSessionRef.current === selected
        )
          void reconcileTranscript(
            selected,
            selectedHostId,
            selectedGeneration,
          );
      }, 0);
  }

  function clearRefreshTimer() {
    if (refreshTimer.current !== null)
      window.clearTimeout(refreshTimer.current);
    refreshTimer.current = null;
  }

  function clearOAuthTimer() {
    if (oauthTimer.current !== null) window.clearTimeout(oauthTimer.current);
    oauthTimer.current = null;
  }

  function clearBrowserReconnectTimer() {
    if (browserReconnectTimer.current !== null)
      window.clearTimeout(browserReconnectTimer.current);
    browserReconnectTimer.current = null;
  }

  function clearTerminalReconnectTimer() {
    if (terminalReconnectTimer.current !== null)
      window.clearTimeout(terminalReconnectTimer.current);
    terminalReconnectTimer.current = null;
  }

  function scheduleRefresh() {
    clearRefreshTimer();
    const targetHostId = connectedHostRef.current ?? hostId;
    const targetGeneration = hostGenerationRef.current;
    const targetSessionId = activeSessionRef.current;
    const activeChannel = channelRef.current;
    if (!targetHostId || !targetSessionId || !activeChannel) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      if (
        connectedHostRef.current === targetHostId &&
        hostGenerationRef.current === targetGeneration &&
        activeSessionRef.current === targetSessionId &&
        channelRef.current === activeChannel
      )
        void refreshSession(targetSessionId, activeChannel);
    }, 180);
  }

  function scheduleBrowserReconnect() {
    if (browserReconnectTimer.current !== null) return;
    const targetHostId = connectedHostRef.current ?? hostId;
    const targetGeneration = hostGenerationRef.current;
    if (!targetHostId) return;
    reconnectAttemptRef.current += 1;
    const delay = relayRetryDelay(reconnectAttemptRef.current - 1);
    browserReconnectTimer.current = window.setTimeout(() => {
      browserReconnectTimer.current = null;
      if (
        connectedHostRef.current === targetHostId &&
        hostGenerationRef.current === targetGeneration
      )
        setReconnectGeneration((value) => value + 1);
    }, delay);
  }

  function scheduleSessionListRefresh() {
    const activeChannel = channelRef.current;
    const targetHostId = connectedHostRef.current ?? hostId;
    if (!activeChannel) return;
    void activeChannel
      .rpc<{ sessions: UiSession[] }>("sessions.list")
      .then((result) => {
        if (
          channelRef.current !== activeChannel ||
          connectedHostRef.current !== targetHostId
        )
          return;
        if (targetHostId)
          sessionsByHostRef.current.set(targetHostId, result.sessions ?? []);
        setSessions(result.sessions ?? []);
        setSessionsPhase(result.sessions?.length ? "ready" : "empty");
      })
      .catch(() => undefined);
  }

  async function refreshSession(
    targetSessionId: string,
    activeChannel = channelRef.current,
  ) {
    if (!activeChannel || !targetSessionId) return;
    const targetHostId = connectedHostRef.current ?? hostId;
    const targetHostGeneration = hostGenerationRef.current;
    const cursorKey = hostSessionKey(targetHostId, targetSessionId);
    const refreshId = ++refreshGenerationRef.current;
    const isCurrent = () =>
      activeSessionRef.current === targetSessionId &&
      refreshGenerationRef.current === refreshId &&
      channelRef.current === activeChannel &&
      connectedHostRef.current === targetHostId &&
      hostGenerationRef.current === targetHostGeneration;
    try {
      const [snapshot, transcriptResult] = await Promise.all([
        activeChannel.rpc<UiSessionSnapshot>("sessions.snapshot", {
          sessionId: targetSessionId,
        }),
        activeChannel
          .rpc<TranscriptPage>("sessions.transcript.read", {
            sessionId: targetSessionId,
            agentId: "main",
            pageSize: 20,
          })
          .catch(() => null),
      ]);
      if (!isCurrent()) return;
      const currentCursor = cursorRef.current.get(cursorKey);
      const snapshotEpoch =
        typeof snapshot.epoch === "string" ? snapshot.epoch : null;
      const epochChanged = Boolean(
        currentCursor?.epoch &&
          snapshotEpoch &&
          currentCursor.epoch !== snapshotEpoch,
      );
      const nextSequence = epochChanged
        ? snapshot.asOfSeq
        : Math.max(currentCursor?.sequence ?? 0, snapshot.asOfSeq);
      cursorRef.current.set(cursorKey, {
        sequence: nextSequence,
        epoch: snapshotEpoch ?? currentCursor?.epoch ?? null,
      });
      setLastSequence(nextSequence);
      const snapshotMessages = withInFlightMessage(
        snapshot.messages,
        snapshot.inFlightTurn,
      );
      messagesRef.current = snapshotMessages;
      setMessages(snapshotMessages);
      if (transcriptResult) {
        const nextTranscript = mergeTranscriptPage(
          transcriptRef.current,
          transcriptSessionIdRef.current,
          targetSessionId,
          transcriptResult,
        );
        transcriptRef.current = nextTranscript;
        setTranscript(nextTranscript);
        transcriptSessionIdRef.current = targetSessionId;
        setTranscriptSessionId(targetSessionId);
        if (transcriptResult.items.length > 0 || snapshotMessages.length === 0)
          clearTranscriptRetry();
        else scheduleTranscriptRetry(targetSessionId);
      } else {
        scheduleTranscriptRetry(targetSessionId);
      }
      setApprovals(snapshot.pendingApprovals ?? []);
      setQuestions(snapshot.pendingQuestions ?? []);
      setTasks(snapshot.tasks ?? []);
      setSessionStatus(snapshot.status);
      const composerDraft = composerDraftRef.current.get(cursorKey);
      setSelectedModel(composerDraft?.model ?? snapshot.status.model ?? "");
      setThinkingLevel(
        composerDraft?.thinkingLevel ?? snapshot.status.thinkingLevel ?? "",
      );
      setError(null);
      setSessions((current) =>
        current.map((item) =>
          item.upstreamSessionId === targetSessionId
            ? {
                ...item,
                permissionMode: snapshot.permissionMode,
                state: snapshot.status.busy
                  ? "running"
                  : (snapshot.pendingApprovals?.length ?? 0) ||
                      (snapshot.pendingQuestions?.length ?? 0)
                    ? "waiting"
                    : "idle",
              }
            : item,
        ),
      );
      void Promise.all([
        activeChannel
          .rpc<{ items: UiFileEntry[] }>("sessions.files.search", {
            sessionId: targetSessionId,
            query: "",
          })
          .catch(() => ({ items: [] })),
        activeChannel
          .rpc<{ entries: Record<string, string> }>("sessions.files.status", {
            sessionId: targetSessionId,
          })
          .catch(() => ({ entries: {} })),
      ]).then(([fileResult, gitResult]) => {
        if (!isCurrent()) return;
        setFiles(fileResult.items ?? []);
        setFileChanges(gitResult.entries ?? {});
      });
    } catch (nextError) {
      if (isCurrent())
        setError(
          nextError instanceof Error ? nextError.message : "读取会话快照失败",
        );
    }
  }

  async function reconcileTranscript(
    targetSessionId: string,
    expectedHostId = connectedHostRef.current ?? hostId,
    expectedGeneration = hostGenerationRef.current,
  ) {
    const activeChannel = channelRef.current;
    if (!activeChannel || !targetSessionId) return;
    const isCurrent = () =>
      channelRef.current === activeChannel &&
      activeSessionRef.current === targetSessionId &&
      connectedHostRef.current === expectedHostId &&
      hostGenerationRef.current === expectedGeneration;
    const current =
      transcriptSessionIdRef.current === targetSessionId
        ? transcriptRef.current
        : null;
    if (current?.seq) {
      try {
        const catchup = await activeChannel.rpc<{
          batches: Array<{ seq: number; ops: TranscriptOperation[] }>;
          latest_seq: number;
          complete: boolean;
        }>("sessions.transcript.resume", {
          sessionId: targetSessionId,
          agentId: "main",
          sinceSeq: current.seq,
        });
        if (catchup.complete) {
          let next = current;
          for (const batch of catchup.batches ?? []) {
            const applied = applyTranscriptOps(next, batch.ops, batch.seq);
            if (applied.gap) throw new Error("transcript gap");
            next = applied.state;
          }
          if (isCurrent()) {
            transcriptRef.current = next;
            setTranscript(next);
          } else {
            return;
          }
          clearTranscriptRetry();
          setError(null);
          return;
        }
      } catch {
        // A complete page below is the authoritative recovery path
      }
    }
    try {
      const page = await activeChannel.rpc<TranscriptPage>(
        "sessions.transcript.read",
        {
          sessionId: targetSessionId,
          agentId: "main",
          pageSize: 20,
        },
      );
      if (isCurrent()) {
        const nextTranscript = mergeTranscriptPage(
          transcriptRef.current,
          transcriptSessionIdRef.current,
          targetSessionId,
          page,
        );
        transcriptRef.current = nextTranscript;
        setTranscript(nextTranscript);
        transcriptSessionIdRef.current = targetSessionId;
        setTranscriptSessionId(targetSessionId);
        if (page.items.length > 0 || messagesRef.current.length === 0) {
          clearTranscriptRetry();
          setError(null);
        } else {
          scheduleTranscriptRetry(targetSessionId);
        }
      } else {
        return;
      }
    } catch (nextError) {
      if (!isCurrent()) return;
      setError(
        nextError instanceof Error ? nextError.message : "恢复对话记录失败",
      );
      scheduleTranscriptRetry(targetSessionId);
    }
  }

  function clearTranscriptRetry() {
    if (transcriptRetryTimer.current !== null)
      window.clearTimeout(transcriptRetryTimer.current);
    transcriptRetryTimer.current = null;
    transcriptRetryAttemptRef.current = 0;
  }

  function scheduleTranscriptRetry(targetSessionId: string) {
    if (
      transcriptRetryTimer.current !== null ||
      !channelRef.current ||
      activeSessionRef.current !== targetSessionId
    )
      return;
    const targetHostId = connectedHostRef.current ?? hostId;
    const targetGeneration = hostGenerationRef.current;
    const activeChannel = channelRef.current;
    if (!targetHostId || !activeChannel) return;
    const delay = transcriptRetryDelay(transcriptRetryAttemptRef.current);
    transcriptRetryAttemptRef.current += 1;
    transcriptRetryTimer.current = window.setTimeout(() => {
      transcriptRetryTimer.current = null;
      if (
        connectedHostRef.current === targetHostId &&
        hostGenerationRef.current === targetGeneration &&
        activeSessionRef.current === targetSessionId &&
        channelRef.current === activeChannel
      )
        void reconcileTranscript(
          targetSessionId,
          targetHostId,
          targetGeneration,
        );
    }, delay);
  }

  async function loadOlderTurns() {
    if (!channel || !session || !transcript || loadingOlder) return;
    const targetSessionId = session.upstreamSessionId;
    const activeChannel = channel;
    const generation = hostGenerationRef.current;
    const oldest = transcript.items.find((item) => item.kind === "turn");
    if (!oldest || oldest.kind !== "turn") return;
    setLoadingOlder(true);
    try {
      const page = await activeChannel.rpc<TranscriptPage>(
        "sessions.transcript.read",
        {
          sessionId: targetSessionId,
          agentId: transcript.agentId,
          pageSize: 20,
          beforeTurn: oldest.turnId,
        },
      );
      if (
        channelRef.current !== activeChannel ||
        activeSessionRef.current !== targetSessionId ||
        hostGenerationRef.current !== generation
      )
        return;
      const nextTranscript = transcriptRef.current
        ? prependTranscriptPage(transcriptRef.current, page)
        : transcriptFromPage(page);
      transcriptRef.current = nextTranscript;
      setTranscript(nextTranscript);
    } catch (nextError) {
      if (
        channelRef.current !== activeChannel ||
        activeSessionRef.current !== targetSessionId ||
        hostGenerationRef.current !== generation
      )
        return;
      setError(
        nextError instanceof Error ? nextError.message : "加载更早记录失败",
      );
    } finally {
      setLoadingOlder(false);
    }
  }

  async function setPermission(mode: PermissionMode) {
    if (!session) return;
    const targetSessionId = session.upstreamSessionId;
    const activeChannel = channel;
    const generation = hostGenerationRef.current;
    const isCurrent = () =>
      activeSessionRef.current === targetSessionId &&
      hostGenerationRef.current === generation &&
      (demo || channelRef.current === activeChannel);
    const previous = session.permissionMode;
    if (!demo && !activeChannel) return;
    setSessions((current) =>
      current.map((item) =>
        item.upstreamSessionId === targetSessionId
          ? { ...item, permissionMode: mode }
          : item,
      ),
    );
    if (demo) return;
    if (!activeChannel) return;
    try {
      const actual = await activeChannel.rpc<{
        permissionMode: PermissionMode;
      }>("sessions.permission.write", {
        sessionId: targetSessionId,
        permissionMode: mode,
      });
      if (actual && isCurrent())
        setSessions((current) =>
          current.map((item) =>
            item.upstreamSessionId === targetSessionId
              ? { ...item, permissionMode: actual.permissionMode }
              : item,
          ),
        );
    } catch (nextError) {
      if (!isCurrent()) return;
      setSessions((current) =>
        current.map((item) =>
          item.upstreamSessionId === targetSessionId
            ? { ...item, permissionMode: previous }
            : item,
        ),
      );
      setError(
        nextError instanceof Error ? nextError.message : "切换权限模式失败",
      );
    }
  }

  async function sendPrompt() {
    const text = prompt.trim();
    if (
      (!text && attachments.length === 0) ||
      !session ||
      host?.state !== "online" ||
      !canSendPrompt(
        host,
        Boolean(session),
        Boolean(channel),
        demo,
        sending,
        Boolean(text || attachments.length),
      )
    )
      return;
    markCompletedTurnsCollapsed();
    if (text.startsWith("/")) {
      const [head] = text.slice(1).split(/\s/u);
      const command = commands.find(
        (candidate) =>
          candidate.name === head || candidate.aliases?.includes(head ?? ""),
      );
      if (command) {
        await executeSlashCommand(
          command,
          text.slice((head?.length ?? 0) + 1).trim(),
        );
        return;
      }
    }
    const targetSession = session;
    const targetSessionId = targetSession.upstreamSessionId;
    const requestGeneration = ++sendRequestRef.current;
    const hostGeneration = hostGenerationRef.current;
    const isCurrentRequest = () =>
      activeSessionRef.current === targetSessionId &&
      hostGenerationRef.current === hostGeneration &&
      sendRequestRef.current === requestGeneration;
    const pendingAttachmentIds = attachments.map((item) => item.id);
    const retry = retryPromptRef.current;
    const promptId =
      retry &&
      retry.hostId === (connectedHostRef.current ?? hostId) &&
      retry.sessionId === session.upstreamSessionId &&
      retry.text === text &&
      retry.attachmentIds.length === pendingAttachmentIds.length &&
      retry.attachmentIds.every(
        (attachmentId, index) => attachmentId === pendingAttachmentIds[index],
      )
        ? retry.promptId
        : crypto.randomUUID();
    const message: UiMessage = {
      id: promptId,
      role: "user",
      text: text || `已添加 ${attachments.length} 个附件`,
      time: new Date().toISOString(),
    };
    if (demo) {
      setMessages((current) => [...current, message]);
      setPrompt("");
      setAttachments([]);
      window.setTimeout(
        () =>
          isCurrentRequest() &&
          setMessages((current) => [
            ...current,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              text: "合成预览已收到提示词；连接真实主机后，将通过加密 Kimi 通道执行",
              time: new Date().toISOString(),
              streaming: true,
            },
          ]),
        350,
      );
      return;
    }
    setSending(true);
    const pendingAttachments = attachments;
    setMessages((current) => [...current, message]);
    setOptimisticMessage(message);
    setPrompt("");
    if (pendingAttachments.length > 0)
      setAttachments((current) =>
        current.map((item) =>
          pendingAttachments.some((pending) => pending.id === item.id)
            ? { id: item.id, file: item.file, status: "uploading" }
            : item,
        ),
      );
    try {
      const content: Array<Record<string, unknown>> = [];
      if (text) content.push({ type: "text", text });
      for (const attachment of pendingAttachments) {
        const uploaded = await uploadAttachment(attachment.file);
        if (attachment.file.type.startsWith("image/")) {
          content.push({
            type: "image",
            source: { kind: "file", file_id: uploaded.id },
          });
        } else if (attachment.file.type.startsWith("video/")) {
          content.push({
            type: "video",
            source: { kind: "file", file_id: uploaded.id },
          });
        } else {
          content.push({
            type: "file",
            file_id: uploaded.id,
            name: uploaded.name,
            media_type: uploaded.media_type,
            size: uploaded.size,
          });
        }
      }
      if (!channel) throw new Error("主机通道不可用");
      await channel.rpc("sessions.prompt", {
        sessionId: targetSessionId,
        promptId: message.id,
        content,
        permissionMode: targetSession.permissionMode,
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        planMode,
      });
      if (isCurrentRequest()) {
        setAttachments([]);
        retryPromptRef.current = null;
      }
    } catch (nextError) {
      if (!isCurrentRequest()) return;
      setMessages((current) =>
        current.filter((item) => item.id !== message.id),
      );
      setOptimisticMessage(null);
      setPrompt(text);
      setAttachments((current) =>
        current.map((item) => ({
          ...item,
          status: "failed",
          error: nextError instanceof Error ? nextError.message : "上传失败",
        })),
      );
      retryPromptRef.current = {
        hostId: connectedHostRef.current ?? hostId,
        sessionId: targetSessionId,
        promptId: message.id,
        text,
        attachmentIds: pendingAttachmentIds,
      };
      setError(
        nextError instanceof Error
          ? kimiErrorText(nextError.message)
          : "发送提示词失败",
      );
    } finally {
      if (sendRequestRef.current === requestGeneration) setSending(false);
    }
  }

  function addAttachments(files: FileList | File[]) {
    const incoming = Array.from(files);
    setAttachments((current) => {
      const available = Math.max(0, 4 - current.length);
      const accepted = incoming.slice(0, available).flatMap((file) => {
        if (file.size > 5 * 1024 * 1024) {
          setError(`${file.name} 超过 5 MiB 限制`);
          return [];
        }
        return [{ id: crypto.randomUUID(), file, status: "ready" as const }];
      });
      if (incoming.length > available) setError("每条消息最多添加 4 个附件");
      return [...current, ...accepted];
    });
  }

  async function uploadAttachment(file: File): Promise<{
    id: string;
    name: string;
    media_type: string;
    size: number;
  }> {
    if (!channel) throw new Error("主机通道不可用");
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    const chunk = 32_768;
    for (let offset = 0; offset < bytes.length; offset += chunk)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
    return channel.rpc("sessions.attachments.upload", {
      name: file.name,
      mediaType: file.type || "application/octet-stream",
      content: btoa(binary),
    });
  }

  async function controlPrompt(promptId: string, action: "steer" | "abort") {
    if (!channel || !session) return;
    const activeChannel = channel;
    const targetSessionId = session.upstreamSessionId;
    const generation = hostGenerationRef.current;
    const isCurrent = () =>
      channelRef.current === activeChannel &&
      activeSessionRef.current === targetSessionId &&
      hostGenerationRef.current === generation;
    const lockKey = `${hostId}:${targetSessionId}:${promptId}`;
    if (promptActionLocksRef.current.has(lockKey)) return;
    const currentState = promptActions[promptId] ?? "idle";
    if (currentState === "applying" || currentState === "pending-confirmation")
      return;
    promptActionLocksRef.current.add(lockKey);
    setPromptActions((current) => ({ ...current, [promptId]: "applying" }));
    try {
      await activeChannel.rpc(
        `sessions.prompts.${action}` as "sessions.prompts.steer",
        {
          sessionId: targetSessionId,
          promptId,
        },
      );
      if (!isCurrent()) return;
      setPromptActions((current) => ({
        ...current,
        [promptId]: "pending-confirmation",
      }));
      let confirmed = false;
      for (const delay of [120, 300, 700, 1_200]) {
        await waitFor(delay);
        if (!isCurrent()) return;
        try {
          const result = await activeChannel.rpc<{
            prompts?: Array<Record<string, unknown>>;
            items?: Array<Record<string, unknown>>;
          }>("sessions.prompts.list", {
            sessionId: session.upstreamSessionId,
          });
          const prompts = result.prompts ?? result.items ?? [];
          const prompt = prompts.find(
            (item) =>
              String(item.promptId ?? item.prompt_id ?? "") === promptId,
          );
          const state = String(
            prompt?.status ?? prompt?.state ?? "",
          ).toLowerCase();
          confirmed =
            action === "abort"
              ? !prompt ||
                ["aborted", "cancelled", "canceled", "failed"].includes(state)
              : !prompt || !["queued", "pending", "blocked"].includes(state);
          if (confirmed) break;
        } catch {
          if (!isCurrent()) return;
          // The next transcript/snapshot refresh remains the confirmation source.
        }
      }
      if (!confirmed) {
        if (!isCurrent()) return;
        setPromptActions((current) => ({
          ...current,
          [promptId]: "pending-confirmation",
        }));
        setError("消息操作已发出，等待主机确认");
        return;
      }
      if (!isCurrent()) return;
      setPromptActions((current) => ({ ...current, [promptId]: "confirmed" }));
      window.setTimeout(() => {
        if (!isCurrent()) return;
        setPromptActions((current) => {
          const next = { ...current };
          delete next[promptId];
          return next;
        });
      }, 1800);
      try {
        await reconcileTranscript(targetSessionId);
      } catch {
        // Confirmation already came from the prompt queue; transcript recovery is independent.
      }
    } catch (nextError) {
      if (!isCurrent()) return;
      if (isTransientPromptChannelError(nextError)) {
        setPromptActions((current) => ({
          ...current,
          [promptId]: "pending-confirmation",
        }));
        setError("消息操作已经发出，通道正在恢复，稍后只读核对结果");
        return;
      }
      setPromptActions((current) => ({ ...current, [promptId]: "failed" }));
      setError(
        nextError instanceof Error ? nextError.message : "消息队列操作失败",
      );
    } finally {
      promptActionLocksRef.current.delete(lockKey);
    }
  }

  async function verifyPendingPromptActions(
    activeChannel: RelayChannel,
    targetSessionId: string,
  ) {
    const generation = hostGenerationRef.current;
    const isCurrent = () =>
      channelRef.current === activeChannel &&
      activeSessionRef.current === targetSessionId &&
      hostGenerationRef.current === generation;
    const pendingIds = Object.entries(promptActions)
      .filter(([, state]) => state === "pending-confirmation")
      .map(([promptId]) => promptId);
    if (!pendingIds.length) return;
    try {
      const result = await activeChannel.rpc<{
        prompts?: Array<Record<string, unknown>>;
      }>("sessions.prompts.list", { sessionId: targetSessionId });
      const prompts = result.prompts ?? [];
      const confirmedIds = pendingIds.filter((promptId) => {
        const prompt = prompts.find(
          (item) => String(item.promptId ?? item.prompt_id ?? "") === promptId,
        );
        const state = String(
          prompt?.status ?? prompt?.state ?? "",
        ).toLowerCase();
        return !prompt || !["queued", "pending", "blocked"].includes(state);
      });
      if (!isCurrent()) return;
      setPromptActions((current) => {
        const next = { ...current };
        for (const promptId of confirmedIds) next[promptId] = "confirmed";
        return next;
      });
      for (const promptId of confirmedIds)
        window.setTimeout(() => {
          if (!isCurrent()) return;
          setPromptActions((current) => {
            const next = { ...current };
            delete next[promptId];
            return next;
          });
        }, 1800);
    } catch {
      // Keep pending-confirmation; the next reconnect or user-visible refresh retries read-only.
    }
  }

  function isTransientPromptChannelError(error: unknown): boolean {
    if (error instanceof ApiError)
      return (
        error.status >= 500 ||
        ["host_offline", "host_degraded"].includes(error.code)
      );
    return (
      error instanceof Error &&
      /中继|通道|代理|主机已离线|超时|断开|重连/u.test(error.message)
    );
  }

  function chooseCommand(command: CommandDescriptor) {
    const suffix = command.argumentHint ? " " : "";
    setPrompt(`/${command.name}${suffix}`);
    setCommandSelection(0);
    window.requestAnimationFrame(() => composer.current?.focus());
  }

  function chooseFileMention(file: UiFileEntry) {
    setPrompt((current) => insertFileMention(current, file.path));
    setFileSelection(0);
    window.requestAnimationFrame(() => composer.current?.focus());
  }

  async function executeSlashCommand(
    command: CommandDescriptor,
    argument: string,
  ) {
    if (!session || !channel) return;
    const activeChannel = channel;
    const targetSessionId = session.upstreamSessionId;
    const generation = hostGenerationRef.current;
    const isCurrent = () =>
      channelRef.current === activeChannel &&
      activeSessionRef.current === targetSessionId &&
      hostGenerationRef.current === generation;
    if (sessionStatus?.busy && command.busy === false) {
      setError(`/${command.name} 需要等待当前任务结束`);
      return;
    }
    if (command.kind === "unavailable") {
      setError(command.description);
      return;
    }
    if (command.kind === "skill") {
      markCompletedTurnsCollapsed();
      try {
        await activeChannel.rpc("sessions.skills.activate", {
          sessionId: targetSessionId,
          skillName: command.skillName ?? command.name,
          args: argument || undefined,
        });
        if (isCurrent()) setPrompt("");
      } catch (nextError) {
        if (isCurrent())
          setError(
            nextError instanceof Error ? nextError.message : "技能激活失败",
          );
      }
      return;
    }
    if (command.kind === "agent") {
      markCompletedTurnsCollapsed();
      if (command.name === "title" && !argument) {
        setError("请输入新标题，例如 /title 新标题");
        return;
      }
      try {
        await activeChannel.rpc("sessions.commands.execute", {
          sessionId: targetSessionId,
          name: command.name,
          ...(command.name === "title" ? { title: argument } : {}),
        });
        if (isCurrent()) {
          setPrompt("");
          scheduleRefresh();
          scheduleSessionListRefresh();
        }
      } catch (nextError) {
        if (isCurrent())
          setError(
            nextError instanceof Error ? nextError.message : "命令执行失败",
          );
      }
      return;
    }
    setPrompt("");
    switch (command.name) {
      case "help":
        setPrompt("/");
        break;
      case "sessions":
        setMobileNav(true);
        break;
      case "tasks":
        setRightPanel(true);
        break;
      case "usage":
      case "login":
        setView("account");
        break;
      case "status":
        setError(
          `${host?.displayName ?? "主机"} · ${status} · ${sessionStatus?.busy ? "运行中" : "空闲"}`,
        );
        break;
      case "copy": {
        const last = [...conversationMessages]
          .reverse()
          .find((message) => message.role === "assistant");
        const transcriptLast = transcript
          ? [...transcript.items].reverse().find((item) => item.kind === "turn")
          : null;
        const text =
          transcriptLast?.kind === "turn"
            ? transcriptLast.steps
                .flatMap((step) => step.frames)
                .filter(
                  (frame) =>
                    frame.kind === "text" && frame.role === "assistant",
                )
                .map((frame) => (frame.kind === "text" ? frame.text : ""))
                .join("")
            : last?.text;
        if (text) await navigator.clipboard.writeText(text);
        break;
      }
      case "theme":
        setTheme(theme === "dark" ? "light" : "dark");
        break;
      case "new":
        setNewSessionOpen(true);
        break;
      case "fork":
        await forkSession();
        break;
      case "permission":
        if (!matchesPermission(argument))
          setError("权限模式只能是 manual、auto 或 yolo");
        else await setPermission(argument);
        break;
      case "web":
        setError("当前已经位于 Web 控制台");
        break;
      case "mcp":
      case "plugins":
        setRightPanel(true);
        setError(`/${command.name} 状态面板正在读取目标主机能力`);
        break;
    }
  }

  async function createSession(input: NewSessionInput) {
    if (!channel || !host) return;
    const activeChannel = channel;
    const targetHostId = host.hostId;
    const generation = hostGenerationRef.current;
    const isCurrent = () =>
      channelRef.current === activeChannel &&
      hostGenerationRef.current === generation;
    pendingWorkspaceSessionRef.current = input;
    setWorkspaceMissing(false);
    try {
      const result = await activeChannel.rpc<{
        session: UiSession;
        initializationErrorCode?: string | null;
      }>("sessions.create", {
        ...(input.title ? { title: input.title } : {}),
        metadata: { cwd: input.workspace },
      });
      if (!isCurrent()) return;
      const created = {
        ...result.session,
        permissionMode: input.permissionMode,
      };
      const initializationWarning = result.initializationErrorCode
        ? "会话已经创建，但默认模型尚未初始化；请在 Kimi 恢复后重试"
        : null;
      const cachedSessions = sessionsByHostRef.current.get(targetHostId) ?? [];
      const mergedSessions = [
        created,
        ...cachedSessions.filter(
          (item) => item.upstreamSessionId !== created.upstreamSessionId,
        ),
      ];
      sessionsByHostRef.current.set(targetHostId, mergedSessions);
      setSessions(mergedSessions);
      setSessionId(created.upstreamSessionId);
      setView("conversation");
      setNewSessionOpen(false);
      pendingWorkspaceSessionRef.current = null;
      const storageKey = `aialra-workspaces:${targetHostId}`;
      let recent: WorkspaceOption[] = [];
      try {
        const parsed = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
        if (Array.isArray(parsed))
          recent = parsed.filter((item): item is WorkspaceOption =>
            Boolean(
              item &&
                typeof item.root === "string" &&
                typeof item.name === "string",
            ),
          );
      } catch {
        recent = [];
      }
      const name =
        input.workspace.split(/[\\/]/u).filter(Boolean).at(-1) ??
        input.workspace;
      const next = [
        { root: input.workspace, name },
        ...recent.filter((item) => item.root !== input.workspace),
      ].slice(0, 20);
      localStorage.setItem(storageKey, JSON.stringify(next));
      setWorkspaceOptions(next);

      try {
        await activeChannel.rpc("sessions.permission.write", {
          sessionId: created.upstreamSessionId,
          permissionMode: input.permissionMode,
        });
      } catch (permissionError) {
        if (isCurrent())
          setError("会话已经创建，但权限模式初始化失败；可以稍后在会话中重试");
        return;
      }
      if (!isCurrent()) return;
      if (initializationWarning) setError(initializationWarning);
      else setError(null);
    } catch (nextError) {
      if (!isCurrent()) return;
      const message = nextError instanceof Error ? nextError.message : "";
      if (/40409|workspace.*(not found|不存在)|工作区不存在/iu.test(message)) {
        setWorkspaceMissing(true);
        setError("工作区不存在，请确认后创建目标主机工作区");
        return;
      }
      setError(nextError instanceof Error ? nextError.message : "创建会话失败");
    }
  }

  async function ensureWorkspaceAndRetry() {
    if (!channel || !host) return;
    const activeChannel = channel;
    const generation = hostGenerationRef.current;
    const isCurrent = () =>
      channelRef.current === activeChannel &&
      hostGenerationRef.current === generation;
    const input = pendingWorkspaceSessionRef.current;
    if (!input) return;
    setActionBusy(true);
    try {
      await activeChannel.rpc("workspaces.ensure", {
        root: input.workspace,
        confirmed: true,
        name:
          input.workspace.split(/[\\/]/u).filter(Boolean).at(-1) ??
          input.workspace,
      });
      if (!isCurrent()) return;
      setWorkspaceMissing(false);
      await createSession(input);
    } catch (nextError) {
      if (isCurrent())
        setError(
          nextError instanceof Error ? nextError.message : "创建工作区失败",
        );
    } finally {
      if (isCurrent()) setActionBusy(false);
    }
  }

  async function archiveSession(target = session) {
    if (!channel || !target) return;
    const activeChannel = channel;
    const generation = hostGenerationRef.current;
    const isCurrent = () =>
      channelRef.current === activeChannel &&
      hostGenerationRef.current === generation;
    setActionBusy(true);
    try {
      await activeChannel.rpc("sessions.archive", {
        sessionId: target.upstreamSessionId,
      });
      if (!isCurrent()) return;
      let verified = await activeChannel.rpc<{ sessions: UiSession[] }>(
        "sessions.list",
      );
      for (const delay of [150, 400, 900]) {
        if (
          !verified.sessions.some(
            (item) => item.upstreamSessionId === target.upstreamSessionId,
          )
        )
          break;
        await waitFor(delay);
        if (!isCurrent()) return;
        verified = await activeChannel.rpc<{ sessions: UiSession[] }>(
          "sessions.list",
        );
      }
      if (
        verified.sessions.some(
          (item) => item.upstreamSessionId === target.upstreamSessionId,
        )
      )
        throw new Error("上游尚未确认归档，请稍后重试");
      if (!isCurrent()) return;
      setSessions(verified.sessions);
      void activeChannel
        .rpc<{ sessions: UiSession[] }>("sessions.list", {
          includeArchived: true,
          archivedOnly: true,
          pageSize: 100,
        })
        .then((result) => {
          if (isCurrent()) setArchivedSessions(result.sessions ?? []);
        })
        .catch(() => undefined);
      setSessionId((current) =>
        current === target.upstreamSessionId
          ? (verified.sessions[0]?.upstreamSessionId ?? "")
          : current,
      );
      setPinnedSessionIds((current) => {
        const next = new Set(current);
        next.delete(target.upstreamSessionId);
        if (isCurrent() && host && !demo)
          void api
            .updateHostPreferences(host.hostId, newSessionDefault, [...next])
            .catch(() => undefined);
        return next;
      });
    } catch (nextError) {
      if (isCurrent())
        setError(
          nextError instanceof Error ? nextError.message : "归档会话失败",
        );
    } finally {
      if (isCurrent()) setActionBusy(false);
    }
  }

  async function restoreSession(target: UiSession) {
    if (!channel) return;
    const activeChannel = channel;
    const generation = hostGenerationRef.current;
    const isCurrent = () =>
      channelRef.current === activeChannel &&
      hostGenerationRef.current === generation;
    setActionBusy(true);
    try {
      await activeChannel.rpc("sessions.restore", {
        sessionId: target.upstreamSessionId,
      });
      if (!isCurrent()) return;
      const [activeResult, archivedResult] = await Promise.all([
        activeChannel.rpc<{ sessions: UiSession[] }>("sessions.list"),
        activeChannel.rpc<{ sessions: UiSession[] }>("sessions.list", {
          includeArchived: true,
          archivedOnly: true,
          pageSize: 100,
        }),
      ]);
      if (!isCurrent()) return;
      setSessions(activeResult.sessions ?? []);
      setArchivedSessions(archivedResult.sessions ?? []);
      setSessionsPhase(activeResult.sessions?.length ? "ready" : "empty");
      setView("conversation");
      setSessionId(target.upstreamSessionId);
    } catch (nextError) {
      if (!isCurrent()) return;
      const message = nextError instanceof Error ? nextError.message : "";
      setError(
        /unsupported|not found|404/iu.test(message)
          ? "当前 Kimi 版本不支持恢复归档对话"
          : message || "恢复归档对话失败",
      );
    } finally {
      if (isCurrent()) setActionBusy(false);
    }
  }

  function beginRename(target: UiSession) {
    setRenameTarget(target);
    setRenameTitle(target.title);
  }

  async function renameSession() {
    if (!channel || !renameTarget) return;
    const activeChannel = channel;
    const generation = hostGenerationRef.current;
    const isCurrent = () =>
      channelRef.current === activeChannel &&
      hostGenerationRef.current === generation;
    const target = renameTarget;
    const title = renameTitle.trim();
    if (!title || title === target.title) return;
    setActionBusy(true);
    try {
      await activeChannel.rpc("sessions.title.write", {
        sessionId: target.upstreamSessionId,
        title,
      });
      if (!isCurrent()) return;
      const verified = await activeChannel.rpc<{ sessions: UiSession[] }>(
        "sessions.list",
      );
      if (!isCurrent()) return;
      const updated = verified.sessions.find(
        (item) => item.upstreamSessionId === target.upstreamSessionId,
      );
      if (!updated || updated.title !== title)
        throw new Error("上游尚未确认新名称，请稍后重试");
      setSessions(verified.sessions);
      setRenameTarget(null);
      setRenameTitle("");
    } catch (nextError) {
      if (isCurrent())
        setError(
          nextError instanceof Error ? nextError.message : "重命名对话失败",
        );
    } finally {
      if (isCurrent()) setActionBusy(false);
    }
  }

  async function togglePinnedSession(target: UiSession) {
    const previous = pinnedSessionIds;
    const next = new Set(previous);
    if (next.has(target.upstreamSessionId))
      next.delete(target.upstreamSessionId);
    else next.add(target.upstreamSessionId);
    setPinnedSessionIds(next);
    if (!host || demo) return;
    const targetHostId = host.hostId;
    const generation = hostGenerationRef.current;
    try {
      const actual = await api.updateHostPreferences(
        targetHostId,
        newSessionDefault,
        [...next],
      );
      if (
        hostGenerationRef.current !== generation ||
        hostsRef.current.find((item) => item.hostId === targetHostId) ===
          undefined
      )
        return;
      setPinnedSessionIds(new Set(actual.pinnedSessionIds ?? [...next]));
    } catch (nextError) {
      if (hostGenerationRef.current !== generation) return;
      setPinnedSessionIds(previous);
      setError(
        nextError instanceof Error ? nextError.message : "更新置顶状态失败",
      );
    }
  }

  async function forkSession() {
    if (!channel || !session) return;
    const activeChannel = channel;
    const targetSessionId = session.upstreamSessionId;
    const targetPermissionMode = session.permissionMode;
    const generation = hostGenerationRef.current;
    const isCurrent = () =>
      channelRef.current === activeChannel &&
      activeSessionRef.current === targetSessionId &&
      hostGenerationRef.current === generation;
    setActionBusy(true);
    try {
      const result = await activeChannel.rpc<{ session: UiSession }>(
        "sessions.fork",
        {
          sessionId: targetSessionId,
          title: `${session.title} (fork)`,
        },
      );
      if (!isCurrent()) return;
      setSessions((current) => [
        { ...result.session, permissionMode: targetPermissionMode },
        ...current,
      ]);
      setSessionId(result.session.upstreamSessionId);
    } catch (nextError) {
      if (isCurrent())
        setError(
          nextError instanceof Error ? nextError.message : "分叉会话失败",
        );
    } finally {
      if (isCurrent()) setActionBusy(false);
    }
  }

  async function interruptSession() {
    if (!channel || !session) return;
    const activeChannel = channel;
    const targetSessionId = session.upstreamSessionId;
    const generation = hostGenerationRef.current;
    const isCurrent = () =>
      channelRef.current === activeChannel &&
      activeSessionRef.current === targetSessionId &&
      hostGenerationRef.current === generation;
    try {
      await activeChannel.rpc("sessions.interrupt", {
        sessionId: targetSessionId,
      });
      if (isCurrent()) scheduleRefresh();
    } catch (nextError) {
      if (isCurrent())
        setError(
          nextError instanceof Error ? nextError.message : "停止当前任务失败",
        );
    }
  }

  async function respondApproval(
    interactionId: string,
    decision: "approved" | "rejected",
  ) {
    if (!channel || !session) return;
    const activeChannel = channel;
    const targetSessionId = session.upstreamSessionId;
    const generation = hostGenerationRef.current;
    const isCurrent = () =>
      channelRef.current === activeChannel &&
      activeSessionRef.current === targetSessionId &&
      hostGenerationRef.current === generation;
    setActionBusy(true);
    try {
      await activeChannel.rpc("sessions.approvals.respond", {
        sessionId: targetSessionId,
        interactionId,
        decision,
        scope: "session",
      });
      if (isCurrent()) await refreshSession(targetSessionId, activeChannel);
    } catch (nextError) {
      if (isCurrent())
        setError(
          nextError instanceof Error ? nextError.message : "提交审批结果失败",
        );
    } finally {
      if (isCurrent()) setActionBusy(false);
    }
  }

  async function respondQuestion(
    interactionId: string,
    answers: Record<string, unknown>,
  ) {
    if (!channel || !session) return;
    const activeChannel = channel;
    const targetSessionId = session.upstreamSessionId;
    const generation = hostGenerationRef.current;
    const isCurrent = () =>
      channelRef.current === activeChannel &&
      activeSessionRef.current === targetSessionId &&
      hostGenerationRef.current === generation;
    setActionBusy(true);
    try {
      await activeChannel.rpc("sessions.questions.respond", {
        sessionId: targetSessionId,
        interactionId,
        answers,
        method: "click",
      });
      if (isCurrent()) await refreshSession(targetSessionId, activeChannel);
    } catch (nextError) {
      if (isCurrent())
        setError(
          nextError instanceof Error ? nextError.message : "提交问题回答失败",
        );
    } finally {
      if (isCurrent()) setActionBusy(false);
    }
  }

  async function dismissQuestion(interactionId: string) {
    if (!channel || !session) return;
    const activeChannel = channel;
    const targetSessionId = session.upstreamSessionId;
    const generation = hostGenerationRef.current;
    const isCurrent = () =>
      channelRef.current === activeChannel &&
      activeSessionRef.current === targetSessionId &&
      hostGenerationRef.current === generation;
    setActionBusy(true);
    try {
      await activeChannel.rpc("sessions.questions.dismiss", {
        sessionId: targetSessionId,
        interactionId,
      });
      if (isCurrent()) await refreshSession(targetSessionId, activeChannel);
    } catch (nextError) {
      if (isCurrent())
        setError(
          nextError instanceof Error ? nextError.message : "忽略问题失败",
        );
    } finally {
      if (isCurrent()) setActionBusy(false);
    }
  }

  async function openFile(path: string) {
    if (!channel || !session) return;
    const activeChannel = channel;
    const targetSessionId = session.upstreamSessionId;
    const generation = hostGenerationRef.current;
    try {
      const preview = await activeChannel.rpc<UiFileRead>(
        "sessions.files.read",
        {
          sessionId: targetSessionId,
          path,
        },
      );
      if (
        channelRef.current === activeChannel &&
        activeSessionRef.current === targetSessionId &&
        hostGenerationRef.current === generation
      )
        setFilePreview(preview);
    } catch (nextError) {
      if (
        channelRef.current === activeChannel &&
        activeSessionRef.current === targetSessionId &&
        hostGenerationRef.current === generation
      )
        setError(
          nextError instanceof Error ? nextError.message : "读取文件失败",
        );
    }
  }

  async function startKimiLogin() {
    if (!channel || !host) return;
    const activeChannel = channel;
    const targetHostId = host.hostId;
    const generation = hostGenerationRef.current;
    const isCurrent = () =>
      channelRef.current === activeChannel &&
      hostGenerationRef.current === generation &&
      oauthHostRef.current === targetHostId;
    oauthHostRef.current = targetHostId;
    clearOAuthTimer();
    try {
      const flow = await activeChannel.rpc<OAuthFlow>("oauth.device.start", {
        region: oauthRegion,
      });
      if (!isCurrent()) return;
      setOauthFlow(flow);
      if (flow.status === "authenticated")
        return void refreshUsage(activeChannel, generation);
      const destination = allowedKimiVerificationUrl(
        flow.verification_uri_complete ?? flow.verification_uri,
      );
      if (oauthRegion === "global" && destination)
        window.open(destination, "_blank", "noopener,noreferrer");
      scheduleOAuthPoll(flow, activeChannel, targetHostId, generation);
    } catch (nextError) {
      if (isCurrent())
        setError(
          nextError instanceof Error ? nextError.message : "Kimi 登录失败",
        );
    }
  }

  function scheduleOAuthPoll(
    flow: OAuthFlow,
    activeChannel: RelayChannel,
    targetHostId: string,
    generation: number,
  ) {
    if (
      flow.status !== "pending" ||
      oauthHostRef.current !== targetHostId ||
      channelRef.current !== activeChannel ||
      hostGenerationRef.current !== generation
    )
      return;
    clearOAuthTimer();
    oauthTimer.current = window.setTimeout(
      async () => {
        oauthTimer.current = null;
        try {
          const next = await activeChannel.rpc<OAuthFlow | null>(
            "oauth.device.poll",
            {},
          );
          if (
            !next ||
            oauthHostRef.current !== targetHostId ||
            channelRef.current !== activeChannel ||
            hostGenerationRef.current !== generation
          )
            return;
          setOauthFlow(next);
          if (next.status === "authenticated")
            await refreshUsage(activeChannel, generation);
          else scheduleOAuthPoll(next, activeChannel, targetHostId, generation);
        } catch (nextError) {
          if (
            channelRef.current === activeChannel &&
            hostGenerationRef.current === generation &&
            oauthHostRef.current === targetHostId
          )
            setError(
              nextError instanceof Error
                ? nextError.message
                : "查询 Kimi 登录状态失败",
            );
        }
      },
      Math.max(1, flow.interval ?? 5) * 1000,
    );
  }

  async function refreshUsage(
    activeChannel = channel,
    generation = hostGenerationRef.current,
  ) {
    if (!activeChannel) return;
    const snapshot = await activeChannel.rpc<UsageSnapshot>("oauth.usage");
    if (
      channelRef.current === activeChannel &&
      hostGenerationRef.current === generation
    )
      setUsage(snapshot);
  }

  async function changeElevation(next: boolean) {
    if (!next || demo) {
      setElevated(next);
      return;
    }
    if (!host?.capabilities.includes("elevation")) {
      setError("所选主机没有可用的提权终端代理");
      return;
    }
    try {
      const elevation = await api.elevationStatus();
      if (elevation.elevated) {
        setElevated(true);
        return;
      }
    } catch {
      // The dedicated Authentik flow below is the source of truth.
    }
    const returnTo = `${location.pathname}?elevated=1`;
    location.assign(`/auth/elevate?returnTo=${encodeURIComponent(returnTo)}`);
  }

  async function changeNewSessionDefault(mode: PermissionMode) {
    if (!host) return;
    const previous = newSessionDefault;
    setNewSessionDefault(mode);
    if (demo) return;
    try {
      const actual = await api.updateHostPreferences(host.hostId, mode);
      setNewSessionDefault(actual.defaultPermissionMode);
    } catch (nextError) {
      setNewSessionDefault(previous);
      setError(
        nextError instanceof Error ? nextError.message : "更新主机偏好设置失败",
      );
    }
  }

  if (authRequired) {
    return (
      <main className="auth-redirect" aria-live="polite">
        <p>正在跳转到身份服务</p>
      </main>
    );
  }

  return (
    <div
      className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${rightPanel ? "" : "details-closed"}`}
    >
      <header className="topbar">
        <button
          className="icon-button mobile-only"
          onClick={() => setMobileNav(true)}
          aria-label="打开导航"
        >
          <Menu size={19} />
        </button>
        <button
          className="icon-button desktop-sidebar-toggle"
          onClick={() => setSidebarCollapsed((value) => !value)}
          aria-label={sidebarCollapsed ? "展开左侧栏" : "折叠左侧栏"}
          title={sidebarCollapsed ? "展开左侧栏" : "折叠左侧栏"}
        >
          {sidebarCollapsed ? (
            <PanelLeftOpen size={18} />
          ) : (
            <PanelLeftClose size={18} />
          )}
        </button>
        <div className="brand">
          <div className="brand-mark">K</div>
          <div>
            <strong>AIALRA Kimi</strong>
            <span>控制台</span>
          </div>
        </div>
        <div className="topbar-center">
          <span className={`connection-dot ${host?.state ?? "offline"}`} />
          <span>{host?.displayName ?? "未选择主机"}</span>
          <em>{status}</em>
        </div>
        <div className="topbar-actions">
          <button
            className="icon-button"
            onClick={() => setRightPanel((value) => !value)}
            aria-label={rightPanel ? "收起详情面板" : "展开详情面板"}
            title={rightPanel ? "收起详情面板" : "展开详情面板"}
          >
            {rightPanel ? (
              <PanelRightClose size={18} />
            ) : (
              <PanelRightOpen size={18} />
            )}
          </button>
          <button
            className="icon-button"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            aria-label="切换主题"
          >
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button className="avatar" aria-label="账号">
            AO
          </button>
        </div>
      </header>

      <aside className={`sidebar ${mobileNav ? "open" : ""}`}>
        <div className="mobile-nav-head mobile-only">
          <strong>导航</strong>
          <button
            className="icon-button"
            onClick={() => setMobileNav(false)}
            aria-label="关闭导航"
          >
            <X size={18} />
          </button>
        </div>
        <div className="host-section">
          <div className="host-heading">
            <p className="section-label">执行主机</p>
            <button
              title="配对主机"
              aria-label="配对执行主机"
              onClick={() => setPairingOpen(true)}
            >
              <Plus size={15} />
            </button>
          </div>
          <div className="host-list">
            {hosts.map((item) => {
              const Icon = hostIcon(item);
              return (
                <button
                  key={item.hostId}
                  className={`host-row ${item.hostId === host?.hostId ? "active" : ""}`}
                  onClick={() => {
                    setHostId(item.hostId);
                    setMobileNav(false);
                  }}
                >
                  <span className="host-icon">
                    <Icon size={17} />
                  </span>
                  <span>
                    <strong>{item.displayName}</strong>
                    <small>
                      {item.mode === "vps"
                        ? "VPS · 在服务器执行"
                        : "远端 · 在目标主机执行"}{" "}
                      · {loginStateText(item.loginState)}
                    </small>
                  </span>
                  <i className={`host-state ${item.state}`} />
                </button>
              );
            })}
            {hostsPhase === "loading" && (
              <p className="empty-list loading-list" role="status">
                正在加载主机…
              </p>
            )}
            {hostsPhase === "reconnecting" && hosts.length === 0 && (
              <p className="empty-list loading-list" role="status">
                正在恢复主机连接…
              </p>
            )}
          </div>
        </div>
        <div className="session-section">
          <div className="session-heading">
            <p className="section-label">会话</p>
            <button
              title="新建会话"
              disabled={!channel && !demo}
              onClick={() => setNewSessionOpen(true)}
            >
              <Plus size={15} />
            </button>
          </div>
          <label className="search-box">
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索此主机"
            />
          </label>
          <div className="session-list">
            {projectGroups.map(({ project, items }) => (
              <section className="project-group" key={project}>
                <div className="project-heading">
                  <strong>{project}</strong>
                  <span>{items.length}</span>
                </div>
                {items.map((item) => {
                  const pinned = pinnedSessionIds.has(item.upstreamSessionId);
                  return (
                    <div
                      key={`${item.hostId}:${item.upstreamSessionId}`}
                      className={`session-row ${item.upstreamSessionId === session?.upstreamSessionId ? "active" : ""}`}
                    >
                      <button
                        className="session-open"
                        onClick={() => {
                          setSessionId(item.upstreamSessionId);
                          setView("conversation");
                          setMobileNav(false);
                        }}
                      >
                        <span className={`session-status ${item.state}`}>
                          <CircleDot size={13} />
                        </span>
                        <span>
                          <strong>{item.title}</strong>
                          <small>{relativeTime(item.updatedAt)}</small>
                        </span>
                      </button>
                      <div className="session-actions">
                        <button
                          title={pinned ? "取消置顶" : "置顶对话"}
                          aria-label={pinned ? "取消置顶" : "置顶对话"}
                          onClick={() => void togglePinnedSession(item)}
                        >
                          {pinned ? <PinOff size={13} /> : <Pin size={13} />}
                        </button>
                        <button
                          title="重命名对话"
                          aria-label="重命名对话"
                          disabled={actionBusy}
                          onClick={() => beginRename(item)}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          title="归档对话"
                          aria-label="归档对话"
                          disabled={actionBusy}
                          onClick={() => void archiveSession(item)}
                        >
                          <Archive size={13} />
                        </button>
                      </div>
                      {item.unread && <i className="unread-dot" />}
                    </div>
                  );
                })}
              </section>
            ))}
            {sessionsPhase === "loading" && (
              <p className="empty-list loading-list" role="status">
                正在加载会话…
              </p>
            )}
            {sessionsPhase === "reconnecting" &&
              filteredSessions.length === 0 && (
                <p className="empty-list loading-list" role="status">
                  正在恢复会话…
                </p>
              )}
            {sessionsPhase === "offline" && filteredSessions.length === 0 && (
              <p className="empty-list" role="status">
                主机离线，暂无可显示的脱敏会话
              </p>
            )}
            {sessionsPhase === "ready" && !filteredSessions.length && (
              <p className="empty-list">
                {query.trim() ? "没有匹配的会话" : "此主机还没有会话"}
              </p>
            )}
            {sessionsPhase === "empty" && !query.trim() && (
              <p className="empty-list">此主机还没有会话</p>
            )}
            {sessionsPhase === "error" && (
              <p className="empty-list">会话暂时无法加载，请稍后重试</p>
            )}
          </div>
        </div>
        <nav className="sidebar-nav">
          <button
            className={view === "terminal" ? "active" : ""}
            onClick={() => {
              setView("terminal");
              setMobileNav(false);
            }}
          >
            <TerminalSquare size={17} /> 终端
          </button>
          <button
            className={view === "account" ? "active" : ""}
            onClick={() => {
              setView("account");
              setMobileNav(false);
            }}
          >
            <Gauge size={17} /> 用量
          </button>
          <button
            className={view === "archive" ? "active" : ""}
            onClick={() => {
              setView("archive");
              setMobileNav(false);
            }}
          >
            <Archive size={17} /> 归档
          </button>
          <button
            className={view === "settings" ? "active" : ""}
            onClick={() => {
              setView("settings");
              setMobileNav(false);
            }}
          >
            <Settings size={17} /> 设置
          </button>
        </nav>
      </aside>
      {mobileNav && (
        <button
          className="nav-scrim mobile-only"
          onClick={() => setMobileNav(false)}
          aria-label="点击背景关闭导航"
        />
      )}

      <main className="main-content">
        {error && (
          <div className="error-banner">
            <span>{error}</span>
            <button onClick={() => setError(null)}>
              <X size={15} />
            </button>
          </div>
        )}
        {view === "conversation" &&
          !session &&
          (sessionsPhase === "loading" || sessionsPhase === "reconnecting") && (
            <div className="offline-state loading-state" role="status">
              <LoaderCircle className="spin" size={28} />
              <h2>
                {sessionsPhase === "loading" ? "正在加载会话" : "正在恢复会话"}
              </h2>
              <p>正在等待所选主机返回会话记录，当前主机不会被自动切换</p>
            </div>
          )}
        {view === "conversation" && !session && sessionsPhase === "offline" && (
          <div className="offline-state" role="status">
            <WifiOff size={28} />
            <h2>主机当前离线</h2>
            <p>仅保留脱敏元数据；主机恢复在线后会自动恢复会话内容</p>
          </div>
        )}
        {view === "conversation" &&
          !session &&
          sessionsPhase !== "offline" &&
          sessionsPhase !== "loading" &&
          sessionsPhase !== "reconnecting" && (
            <div className="offline-state">
              <MessageSquare size={28} />
              <h2>{host ? "尚未选择会话" : "尚未配对主机"}</h2>
              <p>
                {host
                  ? "在所选主机上新建会话即可开始"
                  : "请先配对 VPS 或远端主机"}
              </p>
              {!host && (
                <button
                  className="primary-button"
                  onClick={() => setPairingOpen(true)}
                >
                  <Plus size={16} /> 配对主机
                </button>
              )}
              {host?.state === "online" && (
                <button
                  className="primary-button"
                  onClick={() => setNewSessionOpen(true)}
                >
                  <Plus size={16} /> 新建会话
                </button>
              )}
            </div>
          )}
        {view === "conversation" && session && (
          <>
            <div className="conversation-head">
              <div>
                <p className="breadcrumbs">
                  {host?.displayName} <span>/</span> {session.workspaceAlias}
                </p>
                <h1>{session.title}</h1>
              </div>
              <div className="conversation-actions">
                <div className="permission-control" aria-label="权限模式">
                  {(["manual", "auto", "yolo"] as PermissionMode[]).map(
                    (mode) => (
                      <button
                        key={mode}
                        aria-pressed={session.permissionMode === mode}
                        className={
                          session.permissionMode === mode
                            ? `active ${mode}`
                            : ""
                        }
                        onClick={() => void setPermission(mode)}
                      >
                        {mode === "manual"
                          ? "手动"
                          : mode === "auto"
                            ? "自动"
                            : "YOLO"}
                      </button>
                    ),
                  )}
                </div>
                {sessionStatus?.busy && (
                  <button
                    className="icon-button danger"
                    title="停止当前任务"
                    onClick={() => void interruptSession()}
                  >
                    <Square size={15} />
                  </button>
                )}
                <button
                  className="icon-button"
                  title="分叉会话"
                  disabled={actionBusy}
                  onClick={() => void forkSession()}
                >
                  <GitBranch size={17} />
                </button>
                <button
                  className="icon-button"
                  title="归档会话"
                  disabled={actionBusy}
                  onClick={() => void archiveSession()}
                >
                  <Archive size={17} />
                </button>
              </div>
            </div>
            {host?.state === "offline" || host?.state === "unsupported" ? (
              <div className="offline-state">
                <WifiOff size={28} />
                <h2>
                  此主机当前
                  {host.state === "offline" ? "离线" : "版本不受支持"}
                </h2>
                <p>
                  当前只能查看加密的脱敏元数据，会话正文、文件和终端仍留在主机上
                </p>
              </div>
            ) : (
              <>
                <div
                  className="conversation-body"
                  ref={conversationScrollRef}
                  onScroll={handleConversationScroll}
                >
                  <div className="timeline-note">
                    <Clock3 size={14} />
                    <span>会话记录</span>
                  </div>
                  {transcriptVisible ? (
                    <>
                      <TranscriptTimeline
                        transcript={transcript!}
                        hostId={host?.hostId ?? ""}
                        sessionId={session?.upstreamSessionId ?? ""}
                        autoCollapsedTurnIds={autoCollapsedTurnIds}
                        onLoadOlder={() => void loadOlderTurns()}
                        loadingOlder={loadingOlder}
                      />
                      {optimisticMessage && (
                        <article
                          className="message user optimistic-message"
                          aria-live="polite"
                        >
                          <div className="message-avatar">AO</div>
                          <div className="message-content">
                            <div className="message-meta">
                              <strong>你</strong>
                              <span>{messageTime(optimisticMessage.time)}</span>
                            </div>
                            <MarkdownMessage text={optimisticMessage.text} />
                            <div className="message-actions">
                              <CopyButton text={optimisticMessage.text} />
                            </div>
                          </div>
                        </article>
                      )}
                    </>
                  ) : (
                    conversationMessages.map((message) => (
                      <article
                        key={message.id}
                        className={`message ${message.role} ${message.isError ? "error" : ""}`}
                      >
                        <div className="message-avatar">
                          {message.role === "assistant" ? (
                            <Sparkles size={17} />
                          ) : message.role === "tool" ? (
                            <Command size={16} />
                          ) : (
                            "AO"
                          )}
                        </div>
                        <div className="message-content">
                          <div className="message-meta">
                            <strong>
                              {message.role === "assistant"
                                ? "Kimi"
                                : message.role === "tool"
                                  ? (message.toolName ?? "工具")
                                  : "你"}
                            </strong>
                            <span>{messageTime(message.time)}</span>
                            {message.streaming && <em>处理中</em>}
                          </div>
                          {message.role === "tool" ? (
                            <ToolMessage message={message} />
                          ) : (
                            <MarkdownMessage text={message.text} />
                          )}
                          {message.role !== "tool" && (
                            <div className="message-actions">
                              <CopyButton text={message.text} />
                            </div>
                          )}
                          {message.streaming && (
                            <div className="working-line">
                              <i />
                              <i />
                              <i />
                            </div>
                          )}
                        </div>
                      </article>
                    ))
                  )}
                  <div
                    ref={bottomAnchorRef}
                    className="conversation-bottom-anchor"
                    aria-hidden="true"
                  />
                </div>
                {!followingBottom && (
                  <button
                    type="button"
                    className="return-bottom-button"
                    onClick={returnToConversationBottom}
                  >
                    ↓ 回到底部
                    {unreadWhileScrolled > 0 && (
                      <span>
                        {unreadWhileScrolled > 99 ? "99+" : unreadWhileScrolled}
                      </span>
                    )}
                  </button>
                )}
              </>
            )}
            <InteractionCards
              approvals={approvals}
              questions={questions}
              disabled={actionBusy}
              onApproval={respondApproval}
              onQuestion={respondQuestion}
              onDismissQuestion={dismissQuestion}
            />
            <div className="composer-wrap">
              <CommandMenu
                value={prompt}
                commands={commands}
                selected={commandSelection}
                busy={Boolean(sessionStatus?.busy)}
                onSelectedChange={setCommandSelection}
                onChoose={chooseCommand}
              />
              <FileMentionMenu
                value={prompt}
                files={files}
                selected={fileSelection}
                onSelectedChange={setFileSelection}
                onChoose={chooseFileMention}
              />
              <div
                className="composer"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (canUseComposerAttachments)
                    addAttachments(event.dataTransfer.files);
                }}
              >
                {promptQueue.length > 0 && (
                  <div className="prompt-queue">
                    {promptQueue.map((item) => {
                      const promptId = String(item.promptId ?? "");
                      const state = String(item.status ?? "queued");
                      const actionState = promptActions[promptId] ?? "idle";
                      const actionBusyState =
                        actionState === "applying" ||
                        actionState === "pending-confirmation";
                      return (
                        <div key={promptId}>
                          <span>
                            {actionState === "applying"
                              ? "正在操作"
                              : actionState === "pending-confirmation"
                                ? "等待确认"
                                : actionState === "confirmed"
                                  ? "已确认"
                                  : actionState === "failed"
                                    ? "操作失败"
                                    : state === "running"
                                      ? "正在执行"
                                      : "排队消息"}
                          </span>
                          <code>{promptId.slice(0, 8)}</code>
                          {state === "queued" && (
                            <button
                              type="button"
                              disabled={actionBusyState}
                              onClick={() =>
                                void controlPrompt(promptId, "steer")
                              }
                            >
                              {actionState === "failed"
                                ? "重试注入"
                                : "注入当前执行"}
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={actionBusyState}
                            onClick={() =>
                              void controlPrompt(promptId, "abort")
                            }
                          >
                            取消
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
                {attachments.length > 0 && (
                  <div className="attachment-strip">
                    {attachments.map((attachment) => (
                      <span
                        key={attachment.id}
                        className={
                          attachment.status === "failed" ? "failed" : ""
                        }
                        title={attachment.error}
                      >
                        <Paperclip size={12} />
                        <b>{attachment.file.name}</b>
                        <small>
                          {attachment.status === "uploading"
                            ? "上传中"
                            : attachment.status === "failed"
                              ? "重试"
                              : `${Math.max(1, Math.round(attachment.file.size / 1024))} KiB`}
                        </small>
                        <button
                          type="button"
                          aria-label={`移除 ${attachment.file.name}`}
                          disabled={sending}
                          onClick={() =>
                            setAttachments((current) =>
                              current.filter(
                                (item) => item.id !== attachment.id,
                              ),
                            )
                          }
                        >
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <textarea
                  ref={composer}
                  value={prompt}
                  onChange={(event) => {
                    setPrompt(event.target.value);
                    setCommandSelection(0);
                    setFileSelection(0);
                  }}
                  onPaste={(event) => {
                    const files = Array.from(event.clipboardData.files);
                    if (files.length && canUseComposerAttachments)
                      addAttachments(files);
                  }}
                  onKeyDown={(event) => {
                    if (mentionQuery(prompt) !== null) {
                      const visible = matchingFiles(files, prompt);
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        setFileSelection((value) =>
                          visible.length ? (value + 1) % visible.length : 0,
                        );
                        return;
                      }
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        setFileSelection((value) =>
                          visible.length
                            ? (value - 1 + visible.length) % visible.length
                            : 0,
                        );
                        return;
                      }
                      if (
                        (event.key === "Tab" || event.key === "Enter") &&
                        visible.length
                      ) {
                        event.preventDefault();
                        chooseFileMention(
                          visible[fileSelection] ?? visible[0]!,
                        );
                        return;
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setPrompt((current) =>
                          current.replace(/(?:^|\s)@[^\s]*$/u, ""),
                        );
                        return;
                      }
                    }
                    if (prompt.startsWith("/")) {
                      const visible = filterCommands(commands, prompt);
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        setCommandSelection((value) =>
                          visible.length ? (value + 1) % visible.length : 0,
                        );
                        return;
                      }
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        setCommandSelection((value) =>
                          visible.length
                            ? (value - 1 + visible.length) % visible.length
                            : 0,
                        );
                        return;
                      }
                      if (event.key === "Tab" && visible.length) {
                        event.preventDefault();
                        chooseCommand(visible[commandSelection] ?? visible[0]!);
                        return;
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setPrompt("");
                        return;
                      }
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        visible.length &&
                        !commands.some(
                          (command) => `/${command.name}` === prompt.trim(),
                        )
                      ) {
                        event.preventDefault();
                        chooseCommand(visible[commandSelection] ?? visible[0]!);
                        return;
                      }
                    }
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendPrompt();
                    }
                  }}
                  placeholder={
                    !session
                      ? "请选择会话"
                      : host?.state !== "online"
                        ? "等待主机恢复，草稿会保留"
                        : host.loginState !== "authenticated"
                          ? "请先完成 Kimi 登录，草稿会保留"
                          : !channel
                            ? "等待代理启动，草稿会保留"
                            : `向 ${host?.displayName ?? "所选主机"} 上的 Kimi 发送消息`
                  }
                  disabled={!session}
                  rows={2}
                />
                <div className="composer-footer">
                  <div>
                    <input
                      ref={attachmentInput}
                      className="visually-hidden"
                      type="file"
                      multiple
                      accept="image/*,video/*,.txt,.md,.json,.csv,.pdf,.doc,.docx"
                      onChange={(event) => {
                        if (event.target.files)
                          addAttachments(event.target.files);
                        event.target.value = "";
                      }}
                    />
                    <button
                      type="button"
                      title="添加文件、图片或视频"
                      disabled={!canUseComposerAttachments}
                      onClick={() => attachmentInput.current?.click()}
                    >
                      <Paperclip size={15} /> 附件
                    </button>
                    <select
                      className="composer-select model-select"
                      value={selectedModel}
                      title="本条消息使用的模型"
                      aria-label="模型"
                      onChange={(event) => {
                        const model = event.target.value;
                        setSelectedModel(model);
                        if (session)
                          composerDraftRef.current.set(
                            hostSessionKey(hostId, session.upstreamSessionId),
                            { model, thinkingLevel },
                          );
                      }}
                    >
                      {modelOptions.length === 0 && (
                        <option value={selectedModel}>
                          {selectedModel || "默认模型"}
                        </option>
                      )}
                      {modelOptions.map((model) => (
                        <option key={model.model} value={model.model}>
                          {model.display_name}
                        </option>
                      ))}
                    </select>
                    <select
                      className="composer-select thinking-select"
                      value={thinkingLevel}
                      title="思考强度"
                      aria-label="思考强度"
                      onChange={(event) => {
                        const nextThinkingLevel = event.target.value;
                        setThinkingLevel(nextThinkingLevel);
                        if (session)
                          composerDraftRef.current.set(
                            hostSessionKey(hostId, session.upstreamSessionId),
                            {
                              model: selectedModel,
                              thinkingLevel: nextThinkingLevel,
                            },
                          );
                      }}
                    >
                      <option value="">默认思考</option>
                      {supportedEfforts(
                        modelOptions.find(
                          (model) => model.model === selectedModel,
                        )?.support_efforts,
                      ).map((effort) => (
                        <option key={effort} value={effort}>
                          {effort === "low"
                            ? "低"
                            : effort === "high"
                              ? "高"
                              : effort === "max"
                                ? "最高"
                                : effort}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className={planMode ? "active" : ""}
                      title="Plan mode"
                      onClick={() => setPlanMode((value) => !value)}
                    >
                      Plan {planMode ? "开" : "关"}
                    </button>
                    <button
                      onClick={() => {
                        setPrompt("/");
                        setCommandSelection(0);
                        window.requestAnimationFrame(() =>
                          composer.current?.focus(),
                        );
                      }}
                    >
                      <Command size={15} /> 命令
                    </button>
                    <span>
                      {host?.state !== "online"
                        ? "等待主机恢复，草稿会保留"
                        : host.loginState !== "authenticated"
                          ? "Kimi 未登录，发送已禁用；请到用量页完成官方授权"
                          : !channel
                            ? "等待代理启动"
                            : session.permissionMode === "yolo"
                              ? "YOLO 自动批准常规工具"
                              : session.permissionMode === "auto"
                                ? "自动批准安全工具"
                                : "工具操作需要批准"}
                    </span>
                  </div>
                  <button
                    className="send-button"
                    onClick={() => void sendPrompt()}
                    disabled={
                      (!prompt.trim() && attachments.length === 0) ||
                      host?.state !== "online" ||
                      host?.loginState !== "authenticated" ||
                      !channel ||
                      sending
                    }
                    aria-label="发送消息"
                  >
                    <Send size={17} />
                  </button>
                </div>
              </div>
              <p className="composer-hint">
                内容只为所选主机加密 · Enter 发送 · Shift+Enter 换行
              </p>
            </div>
          </>
        )}

        {view === "archive" && host && (
          <Suspense
            fallback={
              <div className="offline-state" role="status">
                正在加载归档视图…
              </div>
            }
          >
            <LazyArchiveManager
              sessions={archivedSessions}
              loading={archiveLoading}
              unavailable={!channel || host.state !== "online"}
              busy={actionBusy}
              query={archiveQuery}
              onQueryChange={setArchiveQuery}
              onRestore={(target) => void restoreSession(target)}
            />
          </Suspense>
        )}
        {view === "archive" && !host && (
          <div className="offline-state" role="status">
            <Archive size={28} />
            <h2>请选择执行主机</h2>
            <p>配对并选中主机后，这里会显示可恢复的归档对话</p>
          </div>
        )}

        {view === "terminal" && host && (
          <div className="utility-view">
            <div className="conversation-head">
              <div>
                <p className="breadcrumbs">
                  {host.displayName} <span>/</span> 终端
                </p>
                <h1>主机终端</h1>
              </div>
              <span className="security-pill">
                <ShieldCheck size={15} /> 端到端加密
              </span>
            </div>
            <div className="elevation-warning">
              <ShieldCheck size={18} />
              <div>
                <strong>提权会话按设计只在短时间内有效</strong>
                <p>
                  密码直接发送给目标主机且不会保存，浏览器断开后提权进程会立即结束
                </p>
              </div>
            </div>
            <Suspense
              fallback={
                <div className="terminal-loading" role="status">
                  正在加载终端…
                </div>
              }
            >
              <LazyTerminalPanel
                hostId={host.hostId}
                channel={terminalChannel}
                demo={demo}
                theme={theme}
                platform={host.platform}
                elevationAvailable={host.capabilities.includes("elevation")}
                elevated={elevated}
                connectionState={terminalPhase}
                output={terminalOutput}
                exit={terminalExit}
                onElevatedChange={(next) => void changeElevation(next)}
                onReopen={() => {
                  setTerminalExit(null);
                  setTerminalOutput(null);
                  setTerminalGeneration((generation) => generation + 1);
                }}
              />
            </Suspense>
          </div>
        )}

        {view === "account" && (
          <div className="utility-view account-view">
            <div className="conversation-head">
              <div>
                <p className="breadcrumbs">
                  {host?.displayName} <span>/</span> 官方账号
                </p>
                <h1>Kimi 用量</h1>
              </div>
              <span className="sync-time">
                更新于 {usage ? relativeTime(usage.capturedAt) : "从未"}
              </span>
            </div>
            <div className="account-content">
              {usage && (
                <section className="account-card">
                  <div className="account-identity">
                    <div className="account-orb">
                      <Bot size={25} />
                    </div>
                    <div>
                      <strong>{usage.accountLabel}</strong>
                      <span>{usage.planLabel ?? "Kimi 账号"}</span>
                    </div>
                  </div>
                  {usage.windows.length > 0 && (
                    <div className="usage-grid">
                      {usage.windows.map((window) => {
                        const percent = window.limit
                          ? Math.min(100, (window.used / window.limit) * 100)
                          : 0;
                        return (
                          <div className="usage-meter" key={window.label}>
                            <div>
                              <strong>{window.label}</strong>
                              <span>
                                {window.unit === "%"
                                  ? `${Math.round(percent)}% 已用`
                                  : `${Math.round(percent)}% · ${window.used} ${window.unit} 已用`}
                              </span>
                            </div>
                            <div className="meter-track">
                              <i style={{ width: `${percent}%` }} />
                            </div>
                            <small>
                              重置时间{" "}
                              {window.resetAt
                                ? new Date(window.resetAt).toLocaleString(
                                    "zh-CN",
                                  )
                                : "等待官方返回"}
                            </small>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              )}

              {(!usage || usage.upstreamError || oauthFlow) && (
                <KimiOAuthPanel
                  online={host?.state === "online"}
                  region={oauthRegion}
                  flow={oauthFlow}
                  message={
                    usage?.upstreamError
                      ? kimiErrorText(usage.upstreamError)
                      : "所选主机尚未登录官方 Kimi 账号"
                  }
                  onRegionChange={setOauthRegion}
                  onStart={() => void startKimiLogin()}
                />
              )}

              <div className="data-boundary">
                <ShieldCheck size={20} />
                <div>
                  <strong>
                    令牌只保留在 {host?.displayName ?? "所选主机"}
                  </strong>
                  <p>
                    此页面由所选主机读取官方用量，OAuth
                    凭据不会进入浏览器或控制平面
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {view === "settings" && host && (
          <div className="utility-view settings-view">
            <div className="conversation-head">
              <div>
                <p className="breadcrumbs">
                  {host.displayName} <span>/</span> 设置
                </p>
                <h1>主机设置</h1>
              </div>
              <span className={`settings-state-pill ${host.state}`}>
                {host.state === "online"
                  ? "在线"
                  : host.state === "degraded"
                    ? "性能受限"
                    : host.state === "offline"
                      ? "离线"
                      : "版本不受支持"}
              </span>
            </div>
            <section className="settings-card">
              <div>
                <strong>新会话默认权限</strong>
                <p>
                  此设置只用于新建 Kimi
                  会话，已有会话继续采用主机实际返回的权限模式
                </p>
              </div>
              <select
                aria-label="新会话默认权限"
                value={newSessionDefault}
                onChange={(event) =>
                  void changeNewSessionDefault(
                    event.target.value as PermissionMode,
                  )
                }
              >
                <option value="manual">手动</option>
                <option value="auto">自动</option>
                <option value="yolo">YOLO</option>
              </select>
            </section>
            <section className="settings-card host-facts">
              <div>
                <strong>执行位置</strong>
                <p>
                  {host.mode === "vps"
                    ? "命令和 Kimi 会话在 VPS 主机上执行"
                    : "命令和 Kimi 会话在此远端主机上执行"}
                </p>
              </div>
              <dl>
                <div>
                  <dt>模式</dt>
                  <dd>{host.mode === "vps" ? "VPS" : "远端"}</dd>
                </div>
                <div>
                  <dt>平台</dt>
                  <dd>{host.platform}</dd>
                </div>
                <div>
                  <dt>代理版本</dt>
                  <dd>{host.agentVersion}</dd>
                </div>
                <div>
                  <dt>Kimi</dt>
                  <dd>{host.kimiVersion ?? "不可用"}</dd>
                </div>
              </dl>
              <div className="capability-list">
                {host.capabilities.map((capability) => (
                  <span
                    key={capability}
                    tabIndex={0}
                    title={
                      capabilityDescriptions[capability] ?? "目标主机支持的能力"
                    }
                  >
                    {capabilityLabel(capability)}
                  </span>
                ))}
              </div>
            </section>
          </div>
        )}
      </main>

      {rightPanel && (
        <ActivityPanel
          status={sessionStatus}
          loading={
            sessionsPhase === "loading" || sessionsPhase === "reconnecting"
          }
          state={
            !host
              ? "empty"
              : host.state === "offline"
                ? "offline"
                : sessionsPhase === "loading"
                  ? "loading"
                  : sessionsPhase === "reconnecting" || !channel
                    ? "reconnecting"
                    : sessionsPhase === "error"
                      ? "error"
                      : session
                        ? "ready"
                        : "empty"
          }
          view={view}
          hostName={host?.displayName}
          sequence={lastSequence}
          tasks={tasks}
          files={files}
          changes={fileChanges}
          preview={filePreview}
          onOpenFile={(path) => void openFile(path)}
          onClosePreview={() => setFilePreview(null)}
          onClose={() => setRightPanel(false)}
        />
      )}
      {newSessionOpen && host && (
        <NewSessionDialog
          platform={host.platform}
          defaultPermissionMode={newSessionDefault}
          recentWorkspaces={workspaceOptions}
          workspaceMissing={workspaceMissing}
          submitting={actionBusy}
          onCreate={createSession}
          onEnsureWorkspace={ensureWorkspaceAndRetry}
          onClose={() => setNewSessionOpen(false)}
        />
      )}
      {renameTarget && (
        <DialogShell
          labelledBy="rename-dialog-title"
          busy={actionBusy}
          onClose={() => {
            setRenameTarget(null);
            setRenameTitle("");
          }}
        >
          <form
            className="dialog-card"
            onSubmit={(event) => {
              event.preventDefault();
              if (actionBusy) return;
              void renameSession();
            }}
          >
            <div className="dialog-head">
              <div>
                <p className="eyebrow">对话设置</p>
                <h2 id="rename-dialog-title">重命名对话</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                disabled={actionBusy}
                onClick={() => {
                  setRenameTarget(null);
                  setRenameTitle("");
                }}
                aria-label="关闭重命名窗口"
              >
                <X size={17} />
              </button>
            </div>
            <label>
              对话名称
              <input
                data-dialog-initial-focus="true"
                maxLength={200}
                value={renameTitle}
                onChange={(event) => setRenameTitle(event.target.value)}
              />
            </label>
            <div className="dialog-actions">
              <button
                type="button"
                disabled={actionBusy}
                onClick={() => {
                  setRenameTarget(null);
                  setRenameTitle("");
                }}
              >
                取消
              </button>
              <button
                className="primary-button"
                disabled={
                  actionBusy ||
                  !renameTitle.trim() ||
                  renameTitle.trim() === renameTarget.title
                }
              >
                {actionBusy ? "正在保存…" : "保存名称"}
              </button>
            </div>
          </form>
        </DialogShell>
      )}
      {pairingOpen && <PairingDialog onClose={() => setPairingOpen(false)} />}
    </div>
  );
}

function displayEventValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
