import type {
  AgentOperation,
  HostDescriptor,
  HostMode,
  PermissionMode,
  SessionCacheItem,
} from "@aialra-kimi/protocol";

interface ApiErrorBody {
  error?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(apiErrorMessage(code, status));
  }
}

function apiErrorMessage(code: string, status: number): string {
  const messages: Record<string, string> = {
    authentication_required: "登录已失效，请重新登录",
    owner_group_required: "当前账号不属于所有者组",
    recent_elevation_required: "此操作需要重新验证管理员身份",
    csrf_validation_failed: "安全校验失败，请刷新页面后重试",
    oidc_not_configured: "身份登录尚未配置",
    missing_oidc_transaction: "登录事务不存在或已过期",
    invalid_oidc_transaction: "登录事务无效，请重新登录",
    oidc_subject_missing: "身份服务没有返回有效用户",
    elevation_oidc_not_configured: "管理员二次验证尚未配置",
    missing_elevation_transaction: "管理员验证事务不存在或已过期",
    invalid_elevation_transaction: "管理员验证事务无效，请重新验证",
    elevation_subject_mismatch: "管理员验证账号与当前账号不一致",
    elevation_auth_not_recent: "管理员验证已过期，请重新验证",
    host_not_found: "找不到所选主机",
    host_offline: "所选主机已离线",
    host_degraded: "所选主机当前性能受限",
    host_unsupported: "所选主机的 Kimi 版本不受支持",
  };
  return messages[code] ?? `请求失败（HTTP ${status}）`;
}

function cookie(name: string): string | null {
  const prefix = `${encodeURIComponent(name)}=`;
  const part = document.cookie
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return part ? decodeURIComponent(part.slice(prefix.length)) : null;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method?.toUpperCase() ?? "GET";
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const csrf = cookie("aialra_csrf");
    if (csrf) headers.set("x-csrf-token", csrf);
  }
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
    throw new ApiError(
      response.status,
      body.error ?? `http_${response.status}`,
    );
  }
  return response.status === 204
    ? (undefined as T)
    : ((await response.json()) as T);
}

export const api = {
  me: () => request<{ subject: string; displayName: string }>("/api/v1/me"),
  hosts: async () =>
    (await request<{ hosts: HostDescriptor[] }>("/api/v1/hosts")).hosts,
  pairingCode: (displayName: string, mode: HostMode) =>
    request<{ code: string; expiresAt: string }>("/api/v1/pairing-codes", {
      method: "POST",
      body: JSON.stringify({ displayName, mode }),
    }),
  sessionCache: async (hostId: string) =>
    (
      await request<{ sessions: SessionCacheItem[] }>(
        `/api/v1/hosts/${encodeURIComponent(hostId)}/session-cache`,
      )
    ).sessions,
  identity: (hostId: string) =>
    request<{ hostId: string; algorithm: "Ed25519"; publicKeyPem: string }>(
      `/api/v1/hosts/${encodeURIComponent(hostId)}/identity`,
    ),
  grant: (hostId: string, scopes: AgentOperation[]) =>
    request<{ token: string; expiresAt: string }>("/api/v1/relay-grants", {
      method: "POST",
      body: JSON.stringify({ hostId, scopes, ttlSeconds: 120 }),
    }),
  elevationStatus: () =>
    request<{ elevated: boolean; expiresAt: string | null }>(
      "/api/v1/elevation/status",
    ),
  hostPreferences: (hostId: string) =>
    request<{
      defaultPermissionMode: PermissionMode;
      pinnedSessionIds: string[];
    }>(`/api/v1/hosts/${encodeURIComponent(hostId)}/preferences`),
  updateHostPreferences: (
    hostId: string,
    defaultPermissionMode: PermissionMode,
    pinnedSessionIds?: string[],
  ) =>
    request<{
      defaultPermissionMode: PermissionMode;
      pinnedSessionIds?: string[];
    }>(`/api/v1/hosts/${encodeURIComponent(hostId)}/preferences`, {
      method: "PUT",
      body: JSON.stringify({ defaultPermissionMode, pinnedSessionIds }),
    }),
};

export function csrfToken(): string {
  return cookie("aialra_csrf") ?? "";
}
