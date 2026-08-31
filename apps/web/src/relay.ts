import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import type {
  AgentOperation,
  EncryptedChannelFrame,
} from "@aialra-kimi/protocol";
import { api, csrfToken } from "./api.js";
import { relayRetryDelay } from "./recovery-policy.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function unbase64url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(
    normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function pemRawKey(pem: string): Uint8Array {
  const der = unbase64url(
    pem
      .replace(/-----[^-]+-----/gu, "")
      .replace(/\s/gu, "")
      .replaceAll("+", "-")
      .replaceAll("/", "_"),
  );
  if (der.length < 32) throw new Error("Ed25519 公钥无效");
  return der.slice(-32);
}

interface ChannelState {
  hostId: string;
  channelId: string;
  openRequestId: string;
  channel: "kimi" | "terminal" | "elevated-terminal";
  privateKey: Uint8Array;
  browserPublicKey: string;
  grant: string;
  identityKey: Uint8Array;
  key: Uint8Array | null;
  sequence: number;
  ready: Promise<void>;
  resolveReady(): void;
  rejectReady(error: Error): void;
  pending: Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >;
  onEvent(event: unknown): void;
}

interface RpcReply {
  requestId: string;
  ok: boolean;
  body?: unknown;
  error?: string;
}

export class BrowserRelay {
  private socket: WebSocket | null = null;
  private socketReady: Promise<void> | null = null;
  private readonly channels = new Map<string, ChannelState>();
  private readonly hostOnlineWaiters = new Map<string, Set<() => void>>();

  async open(
    hostId: string,
    channel: ChannelState["channel"],
    scopes: AgentOperation[],
    onEvent: (event: unknown) => void,
    signal?: AbortSignal,
  ): Promise<RelayChannel> {
    let attempt = 0;
    for (;;) {
      throwIfAborted(signal);
      try {
        const state = await this.openAttempt(
          hostId,
          channel,
          scopes,
          onEvent,
          signal,
        );
        return new RelayChannel(this, state);
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) throw abortError();
        if (!isRetryableOpenError(error)) throw error;
        await this.waitForRetry(hostId, attempt, signal);
        attempt += 1;
      }
    }
  }

  private async openAttempt(
    hostId: string,
    channel: ChannelState["channel"],
    scopes: AgentOperation[],
    onEvent: (event: unknown) => void,
    signal?: AbortSignal,
  ): Promise<ChannelState> {
    await abortable(this.connect(), signal);
    const [{ token }, identity] = await abortable(
      Promise.all([api.grant(hostId, scopes), api.identity(hostId)]),
      signal,
    );
    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const channelId = crypto.randomUUID();
    const openRequestId = crypto.randomUUID();
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const state: ChannelState = {
      hostId,
      channelId,
      openRequestId,
      channel,
      privateKey,
      browserPublicKey: base64url(publicKey),
      grant: token,
      identityKey: pemRawKey(identity.publicKeyPem),
      key: null,
      sequence: 0,
      ready,
      resolveReady,
      rejectReady,
      pending: new Map(),
      onEvent,
    };
    this.channels.set(channelId, state);
    try {
      throwIfAborted(signal);
      this.send({
        type: "browser.channel.open",
        requestId: openRequestId,
        hostId,
        channelId,
        channel,
        browserEphemeralKey: state.browserPublicKey,
        grant: token,
      });
      await this.waitUntilReady(state, signal);
      return state;
    } catch (error) {
      this.discardChannel(
        state,
        error instanceof Error ? error : new Error("代理通道连接失败"),
        true,
      );
      throw error;
    }
  }

  async rpc(
    state: ChannelState,
    operation: AgentOperation,
    body: unknown,
  ): Promise<unknown> {
    await state.ready;
    if (!state.key) throw new Error("通道密钥不可用");
    const requestId = crypto.randomUUID();
    const sequence = state.sequence++;
    const nonce = randomBytes(24);
    const aad = encoder.encode(
      `${state.channelId}\n${state.channel}\n${sequence}`,
    );
    const plaintext = encoder.encode(
      JSON.stringify({ requestId, operation, body }),
    );
    const sealed = xchacha20poly1305(state.key, nonce, aad).encrypt(plaintext);
    const ciphertext = sealed.slice(0, -16);
    const tag = sealed.slice(-16);
    const response = new Promise<unknown>((resolve, reject) => {
      state.pending.set(requestId, { resolve, reject });
      setTimeout(() => {
        if (state.pending.delete(requestId)) reject(new Error("代理请求超时"));
      }, 30_000);
    });
    const frame: EncryptedChannelFrame = {
      channelId: state.channelId,
      channel: state.channel,
      sequence,
      nonce: base64url(nonce),
      ciphertext: base64url(ciphertext),
      tag: base64url(tag),
    };
    this.send({
      type: "browser.frame",
      hostId: state.hostId,
      grant: state.grant,
      frame,
    });
    return response;
  }

  close(state: ChannelState): void {
    this.discardChannel(state, new Error("通道已关闭"), true);
  }

  private async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.socketReady) return this.socketReady;
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${scheme}//${location.host}/ws/v1/browser?csrf=${encodeURIComponent(csrfToken())}`;
    this.socketReady = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      let ready = false;
      const readyTimer = setTimeout(() => {
        reject(new Error("中继连接超时"));
        socket.close();
      }, 10_000);
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(readyTimer);
          reject(new Error("中继连接失败"));
        },
        { once: true },
      );
      socket.addEventListener("message", (event) => {
        const raw = String(event.data);
        try {
          const message = JSON.parse(raw) as Record<string, unknown>;
          if (message.type === "server.browser.ready") {
            ready = true;
            clearTimeout(readyTimer);
            resolve();
            return;
          }
        } catch {
          return;
        }
        void this.onMessage(raw);
      });
      socket.addEventListener("close", () => {
        clearTimeout(readyTimer);
        if (!ready) reject(new Error("中继已断开"));
        this.socket = null;
        this.socketReady = null;
        for (const channel of this.channels.values()) {
          channel.rejectReady(new Error("中继已断开"));
          channel.onEvent({ type: "channel.disconnected" });
          for (const pending of channel.pending.values())
            pending.reject(new Error("中继已断开"));
          channel.pending.clear();
        }
        this.channels.clear();
      });
    });
    return this.socketReady;
  }

  private send(payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN)
      throw new Error("中继尚未连接");
    this.socket.send(JSON.stringify(payload));
  }

  private async onMessage(raw: string): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === "server.host.offline") {
      const hostId = String(message.hostId);
      for (const channel of [...this.channels.values()]) {
        if (channel.hostId !== hostId) continue;
        channel.onEvent({ type: "channel.disconnected" });
        this.discardChannel(channel, new Error("主机已离线"), true);
      }
      return;
    }
    if (message.type === "server.host.online") {
      this.wakeHost(String(message.hostId));
      return;
    }
    if (message.type === "agent.channel.accept") {
      const channel = this.channels.get(String(message.channelId));
      if (!channel) return;
      const agentPublicKey = String(message.agentEphemeralKey);
      const canonical = [
        channel.channelId,
        channel.browserPublicKey,
        agentPublicKey,
        base64url(sha256(encoder.encode(channel.grant))),
      ].join("\n");
      const signature = unbase64url(String(message.signature));
      if (
        !ed25519.verify(
          signature,
          encoder.encode(canonical),
          channel.identityKey,
        )
      ) {
        channel.rejectReady(new Error("代理通道签名无效"));
        return;
      }
      const shared = x25519.getSharedSecret(
        channel.privateKey,
        unbase64url(agentPublicKey),
      );
      channel.key = hkdf(
        sha256,
        shared,
        encoder.encode(channel.channelId),
        encoder.encode("aialra-kimi-e2e-v1"),
        32,
      );
      channel.resolveReady();
      return;
    }
    if (message.type === "agent.frame") {
      const frame = message.frame as EncryptedChannelFrame;
      const channel = this.channels.get(frame.channelId);
      if (!channel?.key) return;
      try {
        const nonce = unbase64url(frame.nonce);
        const sealed = new Uint8Array([
          ...unbase64url(frame.ciphertext),
          ...unbase64url(frame.tag),
        ]);
        const aad = encoder.encode(
          `${frame.channelId}\n${frame.channel}\n${frame.sequence}`,
        );
        const plaintext = xchacha20poly1305(channel.key, nonce, aad).decrypt(
          sealed,
        );
        const value = JSON.parse(decoder.decode(plaintext)) as
          | RpcReply
          | { event: unknown };
        if ("requestId" in value) {
          const pending = channel.pending.get(value.requestId);
          if (!pending) return;
          channel.pending.delete(value.requestId);
          if (value.ok) pending.resolve(value.body);
          else pending.reject(new Error(value.error ?? "代理请求失败"));
        } else {
          channel.onEvent(value.event);
        }
      } catch {
        channel.onEvent({ type: "channel.integrity_error" });
      }
      return;
    }
    if (message.type === "server.error") {
      const requestId =
        typeof message.requestId === "string" ? message.requestId : null;
      if (requestId) {
        const opening = [...this.channels.values()].find(
          (channel) => channel.openRequestId === requestId,
        );
        if (opening) {
          opening.rejectReady(
            new Error(
              message.code === "host_offline"
                ? "主机已离线"
                : `代理通道连接失败（${String(message.code ?? "unknown")}）`,
            ),
          );
          return;
        }
      }
      for (const channel of this.channels.values()) channel.onEvent(message);
    }
  }

  private async waitUntilReady(
    state: ChannelState,
    signal?: AbortSignal,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await abortable(
        Promise.race([
          state.ready,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("代理通道连接超时")),
              10_000,
            );
          }),
        ]),
        signal,
      );
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  private waitForRetry(
    hostId: string,
    attempt: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const delay = relayRetryDelay(attempt);
    return new Promise<void>((resolve, reject) => {
      const waiters = this.hostOnlineWaiters.get(hostId) ?? new Set();
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const wake = () => settleResolve();
      const cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        waiters.delete(wake);
        if (waiters.size === 0) this.hostOnlineWaiters.delete(hostId);
        signal?.removeEventListener("abort", abort);
      };
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const abort = () => settleReject(abortError());
      waiters.add(wake);
      this.hostOnlineWaiters.set(hostId, waiters);
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(settleResolve, delay);
    });
  }

  private wakeHost(hostId: string): void {
    const waiters = this.hostOnlineWaiters.get(hostId);
    if (!waiters) return;
    for (const wake of [...waiters]) wake();
  }

  private discardChannel(
    state: ChannelState,
    error: Error,
    notifyAgent = false,
  ): void {
    if (!this.channels.delete(state.channelId)) return;
    state.rejectReady(error);
    for (const pending of state.pending.values()) pending.reject(error);
    state.pending.clear();
    if (notifyAgent && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(
        JSON.stringify({
          type: "browser.channel.close",
          hostId: state.hostId,
          channelId: state.channelId,
          reason: "user",
        }),
      );
    }
  }
}

function abortError(): Error {
  return new Error("中继连接已取消");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.message === "中继连接已取消";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function isRetryableOpenError(error: unknown): boolean {
  if (isApiError(error)) {
    return (
      error.status >= 500 ||
      ["host_offline", "host_degraded", "host_unsupported"].includes(error.code)
    );
  }
  if (!(error instanceof Error)) return true;
  return ![
    "代理通道签名无效",
    "通道密钥不可用",
    "授权已失效",
    "登录已失效",
    "当前账号不属于所有者组",
  ].some((marker) => error.message.includes(marker));
}

function isApiError(error: unknown): error is { status: number; code: string } {
  return Boolean(
    error &&
      typeof error === "object" &&
      typeof (error as { status?: unknown }).status === "number" &&
      typeof (error as { code?: unknown }).code === "string",
  );
}

export class RelayChannel {
  constructor(
    private readonly relay: BrowserRelay,
    private readonly state: ChannelState,
  ) {}

  rpc<T>(operation: AgentOperation, body: unknown = {}): Promise<T> {
    return this.relay.rpc(this.state, operation, body) as Promise<T>;
  }

  close(): void {
    this.relay.close(this.state);
  }
}
