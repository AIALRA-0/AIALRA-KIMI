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
  PanelRightClose,
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
  demoHosts,
  demoMessages,
  demoSessions,
  demoUsage,
  type UiSession,
} from "./demo.js";
import { InteractionCards } from "./InteractionCards.js";
import { MarkdownMessage, ToolMessage } from "./MessageBody.js";
import { NewSessionDialog, type NewSessionInput } from "./NewSessionDialog.js";
import { PairingDialog } from "./PairingDialog.js";
import { BrowserRelay, type RelayChannel } from "./relay.js";
import { TerminalPanel } from "./TerminalPanel.js";
import {
  appendAssistantDelta,
  coalesceToolMessages,
  decodeKimiEvent,
  finishAssistantTurn,
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

interface OAuthFlow {
  flow_id: string;
  status: "pending" | "authenticated" | "denied" | "expired" | "cancelled";
  verification_uri?: string;
  verification_uri_complete?: string;
  user_code?: string;
  expires_at?: string;
  interval?: number;
  error_message?: string;
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
  const [mobileNav, setMobileNav] = useState(false);
  const [rightPanel, setRightPanel] = useState(true);
  const [elevated, setElevated] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [oauthFlow, setOauthFlow] = useState<OAuthFlow | null>(null);
  const [newSessionDefault, setNewSessionDefault] =
    useState<PermissionMode>("manual");
  const [reconnectGeneration, setReconnectGeneration] = useState(0);
  const [terminalGeneration, setTerminalGeneration] = useState(0);
  const composer = useRef<HTMLTextAreaElement>(null);
  const channelRef = useRef<RelayChannel | null>(null);
  const activeSessionRef = useRef(sessionId);
  const cursorRef = useRef(new Map<string, number>());
  const refreshTimer = useRef<number | null>(null);
  const oauthTimer = useRef<number | null>(null);
  const oauthHostRef = useRef<string | null>(null);

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

  useEffect(() => {
    activeSessionRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    if (!demo && hostId) localStorage.setItem("aialra-selected-host", hostId);
  }, [demo, hostId]);

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
        if (active) setNewSessionDefault(preferences.defaultPermissionMode);
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
    const timer = window.setInterval(() => void loadHosts(), 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [demo]);

  useEffect(() => {
    if (demo || !host) return;
    let disposed = false;
    let opened: RelayChannel | null = null;
    channelRef.current?.close();
    channelRef.current = null;
    setChannel(null);
    setMessages([]);
    setTasks([]);
    setApprovals([]);
    setQuestions([]);
    setFiles([]);
    setFileChanges({});
    setFilePreview(null);
    setUsage(null);
    setOauthFlow(null);
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
        setChannel(opened);
        const [sessionResult, usageResult] = await Promise.all([
          opened.rpc<{ sessions: UiSession[] }>("sessions.list"),
          opened.rpc<UsageSnapshot>("oauth.usage").catch(() => null),
        ]);
        if (!disposed) {
          setSessions(sessionResult.sessions);
          setSessionId((current) =>
            sessionResult.sessions.some(
              (item) => item.upstreamSessionId === current,
            )
              ? current
              : (sessionResult.sessions[0]?.upstreamSessionId ?? ""),
          );
          setUsage(usageResult);
          setStatus("在线 · 端到端加密");
        }
      } catch (nextError) {
        if (!disposed) {
          setError(
            nextError instanceof Error ? nextError.message : "主机通道连接失败",
          );
          setStatus("状态异常 · 正在重连");
          window.setTimeout(
            () => setReconnectGeneration((value) => value + 1),
            1_500,
          );
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
    void refreshSession(sessionId, channel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, demo, sessionId]);

  useEffect(() => {
    if (view !== "terminal" || demo || !host || host.state !== "online") return;
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
    },
    [],
  );

  function handleAgentEvent(raw: unknown) {
    const event = decodeKimiEvent(raw);
    if (!event) return;
    if (event.type === "channel.disconnected") {
      setStatus("正在重连");
      window.setTimeout(
        () => setReconnectGeneration((value) => value + 1),
        1_500,
      );
      return;
    }
    const selected = activeSessionRef.current;
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
      const [snapshot, fileResult, gitResult] = await Promise.all([
        activeChannel.rpc<UiSessionSnapshot>("sessions.snapshot", {
          sessionId: targetSessionId,
        }),
        activeChannel
          .rpc<{
            items: UiFileEntry[];
          }>("sessions.files.search", { sessionId: targetSessionId, query: "" })
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
      setMessages(
        withInFlightMessage(snapshot.messages, snapshot.inFlightTurn),
      );
      setApprovals(snapshot.pendingApprovals ?? []);
      setQuestions(snapshot.pendingQuestions ?? []);
      setTasks(snapshot.tasks ?? []);
      setSessionStatus(snapshot.status);
      setFiles(fileResult.items ?? []);
      setFileChanges(gitResult.entries ?? {});
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
    if (!text || !session || host?.state !== "online") return;
    const message: UiMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text,
      time: new Date().toISOString(),
    };
    setMessages((current) => [...current, message]);
    setPrompt("");
    if (demo) {
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
    try {
      await channel?.rpc("sessions.prompt", {
        sessionId: session.upstreamSessionId,
        content: [{ type: "text", text }],
        permissionMode: session.permissionMode,
      });
    } catch (nextError) {
      setMessages((current) =>
        current.filter((item) => item.id !== message.id),
      );
      setPrompt(text);
      setError(
        nextError instanceof Error ? nextError.message : "发送提示词失败",
      );
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

  async function archiveSession() {
    if (!channel || !session) return;
    setActionBusy(true);
    try {
      await channel.rpc("sessions.archive", {
        sessionId: session.upstreamSessionId,
      });
      const remaining = sessions.filter(
        (item) => item.upstreamSessionId !== session.upstreamSessionId,
      );
      setSessions(remaining);
      setSessionId(remaining[0]?.upstreamSessionId ?? "");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "归档会话失败");
    } finally {
      setActionBusy(false);
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
      const flow = await channel.rpc<OAuthFlow>("oauth.device.start", {});
      if (oauthHostRef.current !== targetHostId) return;
      setOauthFlow(flow);
      if (flow.status === "authenticated") return void refreshUsage(channel);
      const destination =
        flow.verification_uri_complete ?? flow.verification_uri;
      if (destination)
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
      className={`app-shell ${rightPanel && view === "conversation" && session ? "" : "details-closed"}`}
    >
      <header className="topbar">
        <button
          className="icon-button mobile-only"
          onClick={() => setMobileNav(true)}
          aria-label="打开导航"
        >
          <Menu size={19} />
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
            aria-label="切换详情面板"
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
            {filteredSessions.map((item) => (
              <button
                key={`${item.hostId}:${item.upstreamSessionId}`}
                className={`session-row ${item.upstreamSessionId === session?.upstreamSessionId ? "active" : ""}`}
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
                  <small>
                    {item.workspaceAlias} · {relativeTime(item.updatedAt)}
                  </small>
                </span>
                {item.unread && <i className="unread-dot" />}
              </button>
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
                {conversationMessages.map((message) => (
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
                ))}
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
              <div className="composer">
                <textarea
                  ref={composer}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
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
                    <button>
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
                    disabled={!prompt.trim() || host?.state !== "online"}
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
              elevationAvailable={
                demo || host.capabilities.includes("elevation")
              }
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
            {usage ? (
              <>
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
                  {usage.upstreamError && (
                    <div className="usage-error">
                      <span>{usage.upstreamError}</span>
                      {host?.state === "online" && (
                        <button
                          className="secondary-button"
                          onClick={() => void startKimiLogin()}
                        >
                          登录 Kimi
                        </button>
                      )}
                    </div>
                  )}
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
                              {window.used}
                              {window.unit} 已用
                            </span>
                          </div>
                          <div className="meter-track">
                            <i style={{ width: `${percent}%` }} />
                          </div>
                          <small>
                            重置时间{" "}
                            {window.resetAt
                              ? new Date(window.resetAt).toLocaleString("zh-CN")
                              : "等待官方返回"}
                          </small>
                        </div>
                      );
                    })}
                  </div>
                </section>
                <div className="data-boundary">
                  <ShieldCheck size={20} />
                  <div>
                    <strong>令牌只保留在 {host?.displayName}</strong>
                    <p>
                      此页面由所选主机读取官方用量，OAuth
                      凭据不会进入浏览器或控制平面
                    </p>
                  </div>
                </div>
                {oauthFlow?.status === "pending" && (
                  <div className="oauth-device">
                    <strong>验证码 {oauthFlow.user_code}</strong>
                    <span>请在新打开的 Kimi 页面中完成登录</span>
                    {oauthFlow.verification_uri_complete && (
                      <a
                        href={oauthFlow.verification_uri_complete}
                        target="_blank"
                        rel="noreferrer"
                      >
                        打开登录页面
                      </a>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="offline-state">
                <Gauge size={28} />
                <h2>暂时无法读取用量</h2>
                <p>所选主机可能还没有登录官方 Kimi 账号</p>
                {host?.state === "online" && (
                  <button
                    className="primary-button"
                    onClick={() => void startKimiLogin()}
                  >
                    登录 Kimi
                  </button>
                )}
                {oauthFlow?.status === "pending" && (
                  <div className="oauth-device">
                    <strong>验证码 {oauthFlow.user_code}</strong>
                    <span>请在新打开的 Kimi 页面中完成登录</span>
                    {oauthFlow.verification_uri_complete && (
                      <a
                        href={oauthFlow.verification_uri_complete}
                        target="_blank"
                        rel="noreferrer"
                      >
                        打开登录页面
                      </a>
                    )}
                  </div>
                )}
                {oauthFlow &&
                  oauthFlow.status !== "pending" &&
                  oauthFlow.status !== "authenticated" && (
                    <p>
                      {oauthFlow.error_message ??
                        `登录状态：${oauthFlow.status}`}
                    </p>
                  )}
              </div>
            )}
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
