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

  async open(
    hostId: string,
    channel: ChannelState["channel"],
    scopes: AgentOperation[],
    onEvent: (event: unknown) => void,
  ): Promise<RelayChannel> {
    await this.connect();
    const [{ token }, identity] = await Promise.all([
      api.grant(hostId, scopes),
      api.identity(hostId),
    ]);
    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const channelId = crypto.randomUUID();
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const state: ChannelState = {
      hostId,
      channelId,
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
    this.send({
      type: "browser.channel.open",
      requestId: crypto.randomUUID(),
      hostId,
      channelId,
      channel,
      browserEphemeralKey: state.browserPublicKey,
      grant: token,
    });
    await Promise.race([
      ready,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("代理通道连接超时")), 10_000),
      ),
    ]);
    return new RelayChannel(this, state);
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
    this.channels.delete(state.channelId);
    for (const pending of state.pending.values())
      pending.reject(new Error("通道已关闭"));
    state.pending.clear();
    this.send({
      type: "browser.channel.close",
      hostId: state.hostId,
      channelId: state.channelId,
      reason: "user",
    });
  }

  private async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.socketReady) return this.socketReady;
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${scheme}//${location.host}/ws/v1/browser?csrf=${encodeURIComponent(csrfToken())}`;
    this.socketReady = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("中继连接失败")),
        { once: true },
      );
      socket.addEventListener(
        "message",
        (event) => void this.onMessage(String(event.data)),
      );
      socket.addEventListener("close", () => {
        this.socket = null;
        this.socketReady = null;
        for (const channel of this.channels.values()) {
          channel.rejectReady(new Error("中继已断开"));
          for (const pending of channel.pending.values())
            pending.reject(new Error("中继已断开"));
          channel.pending.clear();
          channel.onEvent({ type: "channel.disconnected" });
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
    const message = JSON.parse(raw) as Record<string, unknown>;
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
      for (const channel of this.channels.values()) channel.onEvent(message);
    }
  }
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
