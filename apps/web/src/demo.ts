import type {
  HostDescriptor,
  PermissionMode,
  SessionCacheItem,
  UsageSnapshot,
} from "@aialra-kimi/protocol";
import type { UiMessage } from "./session-model.js";

export interface UiSession extends SessionCacheItem {
  permissionMode: PermissionMode;
  unread?: boolean;
}

export const demoHosts: HostDescriptor[] = [
  {
    hostId: "host_demo_desktop",
    displayName: "工作室电脑",
    mode: "remote",
    state: "online",
    platform: "windows",
    agentVersion: "0.1.0",
    kimiVersion: "0.39.1",
    loginState: "authenticated",
    lastSeenAt: new Date().toISOString(),
    capabilities: ["terminal", "usage", "files"],
  },
  {
    hostId: "host_demo_vps",
    displayName: "构建服务器",
    mode: "vps",
    state: "online",
    platform: "linux",
    agentVersion: "0.1.0",
    kimiVersion: "0.39.1",
    loginState: "authenticated",
    lastSeenAt: new Date().toISOString(),
    capabilities: ["terminal", "usage", "files", "elevation"],
  },
  {
    hostId: "host_demo_offline",
    displayName: "旅行笔记本",
    mode: "remote",
    state: "offline",
    platform: "windows",
    agentVersion: "0.1.0",
    kimiVersion: "0.39.1",
    loginState: "unknown",
    lastSeenAt: "2026-08-28T18:12:00.000Z",
    capabilities: [],
  },
];

export const demoSessions: UiSession[] = [
  {
    hostId: "host_demo_desktop",
    upstreamSessionId: "session_demo_release",
    title: "准备发布候选版本",
    workspaceAlias: "nebula-console",
    updatedAt: "2026-08-29T02:20:00.000Z",
    state: "running",
    permissionMode: "auto",
    unread: true,
  },
  {
    hostId: "host_demo_desktop",
    upstreamSessionId: "session_demo_search",
    title: "排查重连回归问题",
    workspaceAlias: "relay-lab",
    updatedAt: "2026-08-28T23:44:00.000Z",
    state: "waiting",
    permissionMode: "manual",
  },
  {
    hostId: "host_demo_desktop",
    upstreamSessionId: "session_demo_docs",
    title: "更新运维说明",
    workspaceAlias: "docs-site",
    updatedAt: "2026-08-28T19:08:00.000Z",
    state: "idle",
    permissionMode: "manual",
  },
];

export const demoMessages: UiMessage[] = [
  {
    id: "message-1",
    role: "user",
    text: "运行完整发布检查，并告诉我还有哪些问题会阻止上线",
    time: "19:16",
  },
  {
    id: "message-2",
    role: "assistant",
    text: "## 发布检查\n\n固定版本已经通过以下项目：\n\n- 控制平面构建\n- 双主机重连\n- 浏览器回归\n\n> 仍需完成生产健康检查后再推广",
    time: "19:17",
  },
  {
    id: "message-tool",
    role: "tool",
    toolCallId: "demo-check",
    toolName: "Shell",
    text: '{"command":"verify-release --production"}',
    time: "19:17",
  },
  {
    id: "message-result",
    role: "tool",
    toolCallId: "demo-check",
    toolName: "result",
    text: "<system>Command executed successfully.</system>health: ok",
    time: "19:17",
  },
  {
    id: "message-3",
    role: "assistant",
    text: "我正在缩小问题范围，序列回归和浏览器测试全部通过前，不会推广此版本",
    time: "19:18",
    streaming: true,
  },
];

export const demoUsage: UsageSnapshot = {
  accountLabel: "owner@example.invalid",
  planLabel: "Kimi Code 订阅",
  windows: [
    {
      label: "每周用量",
      used: 63,
      limit: 100,
      resetAt: "2026-09-01T08:00:00.000Z",
      unit: "%",
    },
    {
      label: "五小时用量",
      used: 18,
      limit: 100,
      resetAt: "2026-08-29T05:00:00.000Z",
      unit: "%",
    },
  ],
  extraUsage: 0,
  capturedAt: new Date().toISOString(),
  upstreamError: null,
};
