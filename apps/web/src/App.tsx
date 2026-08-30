import {
  Archive,
  Bot,
  CircleDot,
  Clock3,
  Command,
  Gauge,
  GitBranch,
  Laptop,
  Menu,
  MessageSquare,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
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
import { useEffect, useMemo, useRef, useState } from "react";
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
import { MarkdownMessage, ToolMessage } from "./MessageBody.js";
import { supportedEfforts } from "./model-options.js";
import { NewSessionDialog, type NewSessionInput } from "./NewSessionDialog.js";
import { PairingDialog } from "./PairingDialog.js";
import { transcriptRetryDelay } from "./recovery-policy.js";
import { BrowserRelay, type RelayChannel } from "./relay.js";
import { TerminalPanel } from "./TerminalPanel.js";
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
  turnFailureMessage,
  shouldApplySequence,
  withInFlightMessage,
  type UiFileEntry,
  type UiFileRead,
  type UiMessage,
  type UiSessionSnapshot,
  type UiSessionStatus,
  type UiTask,
} from "./session-model.js";

type MainView = "conversation" | "terminal" | "account" | "settings";

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

const relay = new BrowserRelay();
const kimiScopes = [
  "sessions.list",
  "sessions.create",
  "sessions.read",
  "sessions.archive",
  "sessions.fork",
  "sessions.prompt",
  "sessions.interrupt",
  "sessions.snapshot",
  "sessions.events",
  "sessions.transcript.read",
  "sessions.transcript.resume",
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

function usageErrorText(value: string): string {
  if (/No token for ['\"]kimi-code['\"]/i.test(value)) {
    return "这台主机尚未登录 Kimi Code，请先完成账号授权";
  }
  return value;
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
  const [hostId, setHostId] = useState(demo ? demoHosts[0]!.hostId : "");
  const [sessions, setSessions] = useState<UiSession[]>(
    demo ? demoSessions : [],
  );
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
  const [status, setStatus] = useState(demo ? "合成预览" : "正在连接");
  const [query, setQuery] = useState("");
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [sending, setSending] = useState(false);
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
  const [rightPanel, setRightPanel] = useState(true);
  const [elevated, setElevated] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [oauthFlow, setOauthFlow] = useState<OAuthFlow | null>(null);
  const [oauthRegion, setOauthRegion] =
    useState<KimiOAuthRegion>("mainland-cn");
  const [newSessionDefault, setNewSessionDefault] =
    useState<PermissionMode>("manual");
  const [reconnectGeneration, setReconnectGeneration] = useState(0);
  const [terminalGeneration, setTerminalGeneration] = useState(0);
  const composer = useRef<HTMLTextAreaElement>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const channelRef = useRef<RelayChannel | null>(null);
  const activeSessionRef = useRef(sessionId);
  const messagesRef = useRef(messages);
  const cursorRef = useRef(new Map<string, number>());
  const refreshTimer = useRef<number | null>(null);
  const oauthTimer = useRef<number | null>(null);
  const oauthHostRef = useRef<string | null>(null);
  const connectedHostRef = useRef<string | null>(null);
  const reconnectAttemptRef = useRef(0);
  const browserReconnectTimer = useRef<number | null>(null);
  const transcriptRetryAttemptRef = useRef(0);
  const transcriptRetryTimer = useRef<number | null>(null);
  const composerDraftRef = useRef(
    new Map<string, { model: string; thinkingLevel: string }>(),
  );
  const [pinnedSessionIds, setPinnedSessionIds] =
    useState<Set<string>>(loadPinnedSessions);

  const host =
    hosts.find((candidate) => candidate.hostId === hostId) ?? hosts[0];
  const session =
    sessions.find((candidate) => candidate.upstreamSessionId === sessionId) ??
    sessions[0];
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

  useEffect(() => {
    activeSessionRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

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
    async function loadHosts() {
      try {
        await api.me();
        const nextHosts = await api.hosts();
        if (!active) return;
        setHosts(nextHosts);
        setHostId((current) => preferredHostId(nextHosts, current));
        setStatus(
          nextHosts.length
            ? channelRef.current
              ? "在线 · 端到端加密"
              : "就绪"
            : "尚未配对主机",
        );
      } catch (nextError) {
        if (nextError instanceof ApiError && nextError.status === 401)
          setAuthRequired(true);
        else
          setError(
            nextError instanceof Error ? nextError.message : "控制平面不可用",
          );
      }
    }
    void loadHosts();
    const timer = window.setInterval(() => void loadHosts(), 3_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [demo]);

  useEffect(() => {
    if (demo || !host) return;
    let disposed = false;
    let opened: RelayChannel | null = null;
    const changingHost = connectedHostRef.current !== host.hostId;
    connectedHostRef.current = host.hostId;
    channelRef.current?.close();
    channelRef.current = null;
    setChannel(null);
    if (changingHost) {
      setSessions([]);
      setSessionId("");
      setMessages([]);
      setTranscript(null);
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
      reconnectAttemptRef.current = 0;
    }
    oauthHostRef.current = null;
    if (oauthTimer.current !== null) window.clearTimeout(oauthTimer.current);
    void (async () => {
      try {
        if (host.state === "offline" || host.state === "unsupported") {
          const cached = await api.sessionCache(host.hostId);
          if (!disposed) {
            setSessions(
              cached.map((item) => ({ ...item, permissionMode: "manual" })),
            );
            setSessionId(cached[0]?.upstreamSessionId ?? "");
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
          handleAgentEvent,
        );
        if (disposed) return opened.close();
        channelRef.current = opened;
        const [sessionResult, usageResult] = await Promise.all([
          opened.rpc<{ sessions: UiSession[] }>("sessions.list"),
          opened.rpc<UsageSnapshot>("oauth.usage").catch(() => null),
        ]);
        if (!disposed) {
          setChannel(opened);
          setSessions(sessionResult.sessions);
          setSessionId((current) =>
            sessionResult.sessions.some(
              (item) => item.upstreamSessionId === current,
            )
              ? current
              : (sessionResult.sessions[0]?.upstreamSessionId ?? ""),
          );
          setUsage(usageResult);
          setError(null);
          setStatus("在线 · 端到端加密");
          reconnectAttemptRef.current = 0;
        }
      } catch (nextError) {
        if (!disposed) {
          setError(
            nextError instanceof Error ? nextError.message : "主机通道连接失败",
          );
          setStatus("状态异常 · 正在重连");
          scheduleBrowserReconnect();
        }
      }
    })();
    return () => {
      disposed = true;
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
    if (view !== "terminal" || demo || !host) return;
    if (host.state !== "online") {
      terminalChannel?.close();
      setTerminalChannel(null);
      setTerminalOutput(null);
      return;
    }
    let disposed = false;
    let opened: RelayChannel | null = null;
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
              ? (event as { type?: string; data?: unknown })
              : null;
          if (
            value?.type === "terminal.output" &&
            typeof value.data === "string"
          ) {
            setTerminalOutput((current) => ({
              id: (current?.id ?? 0) + 1,
              data: value.data as string,
            }));
          } else if (value?.type === "channel.disconnected" && !disposed) {
            window.setTimeout(
              () => setTerminalGeneration((generation) => generation + 1),
              1_500,
            );
          }
        },
      )
      .then((nextChannel) => {
        opened = nextChannel;
        if (disposed) nextChannel.close();
        else setTerminalChannel(nextChannel);
      })
      .catch((nextError: unknown) => {
        if (!disposed) {
          setError(
            nextError instanceof Error ? nextError.message : "终端连接失败",
          );
          window.setTimeout(
            () => setTerminalGeneration((generation) => generation + 1),
            1_500,
          );
        }
      });
    return () => {
      disposed = true;
      opened?.close();
      setTerminalChannel(null);
    };
    // Terminal mode switches and relay failures require a fresh encrypted channel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, elevated, host?.hostId, host?.state, view, terminalGeneration]);

  useEffect(
    () => () => {
      if (refreshTimer.current !== null)
        window.clearTimeout(refreshTimer.current);
      if (oauthTimer.current !== null) window.clearTimeout(oauthTimer.current);
      if (browserReconnectTimer.current !== null)
        window.clearTimeout(browserReconnectTimer.current);
      if (transcriptRetryTimer.current !== null)
        window.clearTimeout(transcriptRetryTimer.current);
    },
    [],
  );

  function handleAgentEvent(raw: unknown) {
    const event = decodeKimiEvent(raw);
    if (!event) return;
    if (event.type === "channel.disconnected") {
      setStatus("正在重连");
      scheduleBrowserReconnect();
      return;
    }
    const selected = activeSessionRef.current;
    if (event.type === "transcript.reset") {
      const snapshot = event.payload.snapshot as
        | Record<string, unknown>
        | undefined;
      if (!snapshot || event.sessionId !== selected) return;
      const page: TranscriptPage = {
        agent_id: String(event.payload.agent_id ?? "main"),
        items: (snapshot.items as TranscriptPage["items"]) ?? [],
        has_more: Boolean(event.payload.has_more_older),
        tasks: (snapshot.tasks as TranscriptPage["tasks"]) ?? [],
        interactions: (snapshot.interactions as unknown[]) ?? [],
        attachments:
          (snapshot.attachments as TranscriptPage["attachments"]) ?? [],
        todos: (snapshot.todos as TranscriptPage["todos"]) ?? [],
        prompts: (snapshot.prompts as TranscriptPage["prompts"]) ?? [],
        meta: (snapshot.meta as Record<string, unknown>) ?? {},
        agents: [],
        pending_interactions: [],
        ...(typeof event.payload.seq === "number"
          ? { seq: event.payload.seq }
          : {}),
      };
      setTranscript((current) => applyTranscriptReset(current, page));
      setTranscriptSessionId(selected);
      return;
    }
    if (event.type === "transcript.ops") {
      if (event.sessionId !== selected) return;
      const operations = Array.isArray(event.payload.ops)
        ? (event.payload.ops as TranscriptOperation[])
        : [];
      const sequence =
        typeof event.payload.seq === "number" ? event.payload.seq : undefined;
      setTranscript((current) => {
        const base =
          current && transcriptSessionId === selected
            ? current
            : emptyTranscript(String(event.payload.agent_id ?? "main"));
        const result = applyTranscriptOps(base, operations, sequence);
        if (result.gap)
          window.setTimeout(() => void reconcileTranscript(selected), 0);
        return result.state;
      });
      setTranscriptSessionId(selected);
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
    const cursor = cursorRef.current.get(selected) ?? 0;
    if (!shouldApplySequence(cursor, event.sequence)) return;
    if (event.sequence !== null) {
      cursorRef.current.set(selected, event.sequence);
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
      setError(String(event.payload.message ?? "Kimi 返回了错误"));
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

  function scheduleRefresh() {
    if (refreshTimer.current !== null)
      window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(
      () => void refreshSession(activeSessionRef.current),
      180,
    );
  }

  function scheduleBrowserReconnect() {
    if (browserReconnectTimer.current !== null) return;
    reconnectAttemptRef.current += 1;
    const ceiling = Math.min(
      500 * 2 ** Math.max(0, reconnectAttemptRef.current - 1),
      15_000,
    );
    const delay = Math.round(ceiling * (0.65 + Math.random() * 0.35));
    browserReconnectTimer.current = window.setTimeout(() => {
      browserReconnectTimer.current = null;
      setReconnectGeneration((value) => value + 1);
    }, delay);
  }

  function scheduleSessionListRefresh() {
    const activeChannel = channelRef.current;
    if (!activeChannel) return;
    void activeChannel
      .rpc<{ sessions: UiSession[] }>("sessions.list")
      .then((result) => setSessions(result.sessions))
      .catch(() => undefined);
  }

  async function refreshSession(
    targetSessionId: string,
    activeChannel = channelRef.current,
  ) {
    if (!activeChannel || !targetSessionId) return;
    try {
      const [snapshot, transcriptResult, fileResult, gitResult] =
        await Promise.all([
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
          activeChannel
            .rpc<{
              items: UiFileEntry[];
            }>("sessions.files.search", {
              sessionId: targetSessionId,
              query: "",
            })
            .catch(() => ({ items: [] })),
          activeChannel
            .rpc<{
              entries: Record<string, string>;
            }>("sessions.files.status", { sessionId: targetSessionId })
            .catch(() => ({ entries: {} })),
        ]);
      if (activeSessionRef.current !== targetSessionId) return;
      cursorRef.current.set(targetSessionId, snapshot.asOfSeq);
      setLastSequence(snapshot.asOfSeq);
      const snapshotMessages = withInFlightMessage(
        snapshot.messages,
        snapshot.inFlightTurn,
      );
      messagesRef.current = snapshotMessages;
      setMessages(snapshotMessages);
      if (transcriptResult) {
        setTranscript((current) =>
          mergeTranscriptPage(
            current,
            transcriptSessionId,
            targetSessionId,
            transcriptResult,
          ),
        );
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
      const composerDraft = composerDraftRef.current.get(targetSessionId);
      setSelectedModel(composerDraft?.model ?? snapshot.status.model ?? "");
      setThinkingLevel(
        composerDraft?.thinkingLevel ?? snapshot.status.thinkingLevel ?? "",
      );
      setFiles(fileResult.items ?? []);
      setFileChanges(gitResult.entries ?? {});
      setError(null);
      setSessions((current) =>
        current.map((item) =>
          item.upstreamSessionId === targetSessionId
            ? {
                ...item,
                permissionMode: snapshot.permissionMode,
                state: snapshot.status.busy
                  ? "running"
                  : snapshot.pendingApprovals.length ||
                      snapshot.pendingQuestions.length
                    ? "waiting"
                    : "idle",
              }
            : item,
        ),
      );
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "读取会话快照失败",
      );
    }
  }

  async function reconcileTranscript(targetSessionId: string) {
    const activeChannel = channelRef.current;
    if (!activeChannel || !targetSessionId) return;
    const current = transcriptSessionId === targetSessionId ? transcript : null;
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
          if (activeSessionRef.current === targetSessionId) setTranscript(next);
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
      if (activeSessionRef.current === targetSessionId) {
        setTranscript((current) =>
          mergeTranscriptPage(
            current,
            transcriptSessionId,
            targetSessionId,
            page,
          ),
        );
        setTranscriptSessionId(targetSessionId);
        if (page.items.length > 0 || messagesRef.current.length === 0) {
          clearTranscriptRetry();
          setError(null);
        } else {
          scheduleTranscriptRetry(targetSessionId);
        }
      }
    } catch (nextError) {
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
    const delay = transcriptRetryDelay(transcriptRetryAttemptRef.current);
    transcriptRetryAttemptRef.current += 1;
    transcriptRetryTimer.current = window.setTimeout(() => {
      transcriptRetryTimer.current = null;
      void reconcileTranscript(targetSessionId);
    }, delay);
  }

  async function loadOlderTurns() {
    if (!channel || !session || !transcript || loadingOlder) return;
    const oldest = transcript.items.find((item) => item.kind === "turn");
    if (!oldest || oldest.kind !== "turn") return;
    setLoadingOlder(true);
    try {
      const page = await channel.rpc<TranscriptPage>(
        "sessions.transcript.read",
        {
          sessionId: session.upstreamSessionId,
          agentId: transcript.agentId,
          pageSize: 20,
          beforeTurn: oldest.turnId,
        },
      );
      setTranscript((current) =>
        current
          ? prependTranscriptPage(current, page)
          : transcriptFromPage(page),
      );
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "加载更早记录失败",
      );
    } finally {
      setLoadingOlder(false);
    }
  }

  async function setPermission(mode: PermissionMode) {
    if (!session) return;
    const previous = session.permissionMode;
    setSessions((current) =>
      current.map((item) =>
        item.upstreamSessionId === session.upstreamSessionId
          ? { ...item, permissionMode: mode }
          : item,
      ),
    );
    if (demo) return;
    try {
      const actual = await channel?.rpc<{ permissionMode: PermissionMode }>(
        "sessions.permission.write",
        { sessionId: session.upstreamSessionId, permissionMode: mode },
      );
      if (actual)
        setSessions((current) =>
          current.map((item) =>
            item.upstreamSessionId === session.upstreamSessionId
              ? { ...item, permissionMode: actual.permissionMode }
              : item,
          ),
        );
    } catch (nextError) {
      setSessions((current) =>
        current.map((item) =>
          item.upstreamSessionId === session.upstreamSessionId
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
      sending
    )
      return;
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
    const message: UiMessage = {
      id: crypto.randomUUID(),
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
    try {
      const content: Array<Record<string, unknown>> = [];
      if (text) content.push({ type: "text", text });
      for (const attachment of attachments) {
        setAttachments((current) =>
          current.map((item) =>
            item.id === attachment.id
              ? { id: item.id, file: item.file, status: "uploading" }
              : item,
          ),
        );
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
      setMessages((current) => [...current, message]);
      setPrompt("");
      await channel?.rpc("sessions.prompt", {
        sessionId: session.upstreamSessionId,
        promptId: message.id,
        content,
        permissionMode: session.permissionMode,
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        planMode,
      });
      setAttachments([]);
    } catch (nextError) {
      setMessages((current) =>
        current.filter((item) => item.id !== message.id),
      );
      setPrompt(text);
      setAttachments((current) =>
        current.map((item) => ({
          ...item,
          status: "failed",
          error: nextError instanceof Error ? nextError.message : "上传失败",
        })),
      );
      setError(
        nextError instanceof Error ? nextError.message : "发送提示词失败",
      );
    } finally {
      setSending(false);
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
    try {
      await channel.rpc(
        `sessions.prompts.${action}` as "sessions.prompts.steer",
        {
          sessionId: session.upstreamSessionId,
          promptId,
        },
      );
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "消息队列操作失败",
      );
    }
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
    if (sessionStatus?.busy && command.busy === false) {
      setError(`/${command.name} 需要等待当前任务结束`);
      return;
    }
    if (command.kind === "unavailable") {
      setError(command.description);
      return;
    }
    if (command.kind === "skill") {
      try {
        await channel.rpc("sessions.skills.activate", {
          sessionId: session.upstreamSessionId,
          skillName: command.skillName ?? command.name,
          args: argument || undefined,
        });
        setPrompt("");
      } catch (nextError) {
        setError(
          nextError instanceof Error ? nextError.message : "技能激活失败",
        );
      }
      return;
    }
    if (command.kind === "agent") {
      if (command.name === "title" && !argument) {
        setError("请输入新标题，例如 /title 新标题");
        return;
      }
      try {
        await channel.rpc("sessions.commands.execute", {
          sessionId: session.upstreamSessionId,
          name: command.name,
          ...(command.name === "title" ? { title: argument } : {}),
        });
        setPrompt("");
        scheduleRefresh();
        scheduleSessionListRefresh();
      } catch (nextError) {
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
    try {
      const result = await channel.rpc<{ session: UiSession }>(
        "sessions.create",
        {
          ...(input.title ? { title: input.title } : {}),
          metadata: { cwd: input.workspace },
        },
      );
      await channel.rpc("sessions.permission.write", {
        sessionId: result.session.upstreamSessionId,
        permissionMode: input.permissionMode,
      });
      const created = {
        ...result.session,
        permissionMode: input.permissionMode,
      };
      setSessions((current) => [
        created,
        ...current.filter(
          (item) => item.upstreamSessionId !== created.upstreamSessionId,
        ),
      ]);
      setSessionId(created.upstreamSessionId);
      setView("conversation");
      setNewSessionOpen(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "创建会话失败");
    }
  }

  async function archiveSession(target = session) {
    if (!channel || !target) return;
    setActionBusy(true);
    try {
      await channel.rpc("sessions.archive", {
        sessionId: target.upstreamSessionId,
      });
      let verified = await channel.rpc<{ sessions: UiSession[] }>(
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
        verified = await channel.rpc<{ sessions: UiSession[] }>(
          "sessions.list",
        );
      }
      if (
        verified.sessions.some(
          (item) => item.upstreamSessionId === target.upstreamSessionId,
        )
      )
        throw new Error("上游尚未确认归档，请稍后重试");
      setSessions(verified.sessions);
      setSessionId((current) =>
        current === target.upstreamSessionId
          ? (verified.sessions[0]?.upstreamSessionId ?? "")
          : current,
      );
      setPinnedSessionIds((current) => {
        const next = new Set(current);
        next.delete(target.upstreamSessionId);
        if (host && !demo)
          void api
            .updateHostPreferences(host.hostId, newSessionDefault, [...next])
            .catch(() => undefined);
        return next;
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "归档会话失败");
    } finally {
      setActionBusy(false);
    }
  }

  async function renameSession(target: UiSession) {
    if (!channel) return;
    const title = window.prompt("输入新的对话名称", target.title)?.trim();
    if (!title || title === target.title) return;
    setActionBusy(true);
    try {
      await channel.rpc("sessions.title.write", {
        sessionId: target.upstreamSessionId,
        title,
      });
      const verified = await channel.rpc<{ sessions: UiSession[] }>(
        "sessions.list",
      );
      const updated = verified.sessions.find(
        (item) => item.upstreamSessionId === target.upstreamSessionId,
      );
      if (!updated || updated.title !== title)
        throw new Error("上游尚未确认新名称，请稍后重试");
      setSessions(verified.sessions);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "重命名对话失败",
      );
    } finally {
      setActionBusy(false);
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
    try {
      const actual = await api.updateHostPreferences(
        host.hostId,
        newSessionDefault,
        [...next],
      );
      setPinnedSessionIds(new Set(actual.pinnedSessionIds ?? [...next]));
    } catch (nextError) {
      setPinnedSessionIds(previous);
      setError(
        nextError instanceof Error ? nextError.message : "更新置顶状态失败",
      );
    }
  }

  async function forkSession() {
    if (!channel || !session) return;
    setActionBusy(true);
    try {
      const result = await channel.rpc<{ session: UiSession }>(
        "sessions.fork",
        {
          sessionId: session.upstreamSessionId,
          title: `${session.title} (fork)`,
        },
      );
      setSessions((current) => [
        { ...result.session, permissionMode: session.permissionMode },
        ...current,
      ]);
      setSessionId(result.session.upstreamSessionId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "分叉会话失败");
    } finally {
      setActionBusy(false);
    }
  }

  async function interruptSession() {
    if (!channel || !session) return;
    try {
      await channel.rpc("sessions.interrupt", {
        sessionId: session.upstreamSessionId,
      });
      scheduleRefresh();
    } catch (nextError) {
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
    setActionBusy(true);
    try {
      await channel.rpc("sessions.approvals.respond", {
        sessionId: session.upstreamSessionId,
        interactionId,
        decision,
        scope: "session",
      });
      await refreshSession(session.upstreamSessionId, channel);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "提交审批结果失败",
      );
    } finally {
      setActionBusy(false);
    }
  }

  async function respondQuestion(
    interactionId: string,
    answers: Record<string, unknown>,
  ) {
    if (!channel || !session) return;
    setActionBusy(true);
    try {
      await channel.rpc("sessions.questions.respond", {
        sessionId: session.upstreamSessionId,
        interactionId,
        answers,
        method: "click",
      });
      await refreshSession(session.upstreamSessionId, channel);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "提交问题回答失败",
      );
    } finally {
      setActionBusy(false);
    }
  }

  async function dismissQuestion(interactionId: string) {
    if (!channel || !session) return;
    setActionBusy(true);
    try {
      await channel.rpc("sessions.questions.dismiss", {
        sessionId: session.upstreamSessionId,
        interactionId,
      });
      await refreshSession(session.upstreamSessionId, channel);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "忽略问题失败");
    } finally {
      setActionBusy(false);
    }
  }

  async function openFile(path: string) {
    if (!channel || !session) return;
    try {
      setFilePreview(
        await channel.rpc<UiFileRead>("sessions.files.read", {
          sessionId: session.upstreamSessionId,
          path,
        }),
      );
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "读取文件失败");
    }
  }

  async function startKimiLogin() {
    if (!channel || !host) return;
    const targetHostId = host.hostId;
    oauthHostRef.current = targetHostId;
    try {
      const flow = await channel.rpc<OAuthFlow>("oauth.device.start", {
        region: oauthRegion,
      });
      if (oauthHostRef.current !== targetHostId) return;
      setOauthFlow(flow);
      if (flow.status === "authenticated") return void refreshUsage(channel);
      const destination = allowedKimiVerificationUrl(
        flow.verification_uri_complete ?? flow.verification_uri,
      );
      if (oauthRegion === "global" && destination)
        window.open(destination, "_blank", "noopener,noreferrer");
      scheduleOAuthPoll(flow, channel, targetHostId);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "Kimi 登录失败",
      );
    }
  }

  function scheduleOAuthPoll(
    flow: OAuthFlow,
    activeChannel: RelayChannel,
    targetHostId: string,
  ) {
    if (flow.status !== "pending" || oauthHostRef.current !== targetHostId)
      return;
    oauthTimer.current = window.setTimeout(
      async () => {
        try {
          const next = await activeChannel.rpc<OAuthFlow | null>(
            "oauth.device.poll",
            {},
          );
          if (!next || oauthHostRef.current !== targetHostId) return;
          setOauthFlow(next);
          if (next.status === "authenticated")
            await refreshUsage(activeChannel);
          else scheduleOAuthPoll(next, activeChannel, targetHostId);
        } catch (nextError) {
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

  async function refreshUsage(activeChannel = channel) {
    if (!activeChannel) return;
    setUsage(await activeChannel.rpc<UsageSnapshot>("oauth.usage"));
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
      <main className="login-screen">
        <div className="login-card">
          <div className="brand-mark">K</div>
          <p className="eyebrow">私有控制台</p>
          <h1>集中管理你的 Kimi 主机</h1>
          <p>
            通过已配置的身份服务登录，仅所有者组可以访问，并且必须完成多因素验证
          </p>
          <a className="primary-button" href="/auth/login">
            使用 Authentik 登录
          </a>
          <div className="security-note">
            <ShieldCheck size={17} /> 主机内容只保留在所选设备上
          </div>
        </div>
      </main>
    );
  }

  return (
    <div
      className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${rightPanel && view === "conversation" && session ? "" : "details-closed"}`}
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
            <PanelRightClose size={18} />
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
                        : "远端 · 在目标主机执行"}
                    </small>
                  </span>
                  <i className={`host-state ${item.state}`} />
                </button>
              );
            })}
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
                          onClick={() => void renameSession(item)}
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
            {!filteredSessions.length && (
              <p className="empty-list">此主机还没有会话</p>
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
        {view === "conversation" && !session && (
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
              <div className="conversation-body">
                <div className="timeline-note">
                  <Clock3 size={14} />
                  <span>会话记录</span>
                </div>
                {shouldRenderTranscript(
                  transcript,
                  transcriptSessionId,
                  session?.upstreamSessionId ?? "",
                  conversationMessages.length,
                ) ? (
                  <TranscriptTimeline
                    transcript={transcript!}
                    hostId={host?.hostId ?? ""}
                    sessionId={session?.upstreamSessionId ?? ""}
                    onLoadOlder={() => void loadOlderTurns()}
                    loadingOlder={loadingOlder}
                  />
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
              </div>
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
                  addAttachments(event.dataTransfer.files);
                }}
              >
                {promptQueue.length > 0 && (
                  <div className="prompt-queue">
                    {promptQueue.map((item) => {
                      const promptId = String(item.promptId ?? "");
                      const state = String(item.status ?? "queued");
                      return (
                        <div key={promptId}>
                          <span>
                            {state === "running" ? "正在执行" : "排队消息"}
                          </span>
                          <code>{promptId.slice(0, 8)}</code>
                          {state === "queued" && (
                            <button
                              onClick={() =>
                                void controlPrompt(promptId, "steer")
                              }
                            >
                              注入当前执行
                            </button>
                          )}
                          <button
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
                    if (files.length) addAttachments(files);
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
                    host?.state !== "online"
                      ? "主机不可用"
                      : `向 ${host?.displayName ?? "所选主机"} 上的 Kimi 发送消息`
                  }
                  disabled={host?.state !== "online"}
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
                            session.upstreamSessionId,
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
                            session.upstreamSessionId,
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
                      {session.permissionMode === "yolo"
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
            <TerminalPanel
              hostId={host.hostId}
              channel={terminalChannel}
              demo={demo}
              platform={host.platform}
              elevationAvailable={host.capabilities.includes("elevation")}
              elevated={elevated}
              output={terminalOutput}
              onElevatedChange={(next) => void changeElevation(next)}
            />
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
                      ? usageErrorText(usage.upstreamError)
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
                  <span key={capability}>{capability}</span>
                ))}
              </div>
            </section>
          </div>
        )}
      </main>

      {rightPanel && view === "conversation" && session && (
        <ActivityPanel
          status={sessionStatus}
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
          onCreate={createSession}
          onClose={() => setNewSessionOpen(false)}
        />
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
