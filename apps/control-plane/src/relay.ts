import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  AgentEnvelopeSchema,
  BrowserEnvelopeSchema,
  type AgentEnvelope,
  type HostState,
  type HostDescriptor,
  type LoginState,
} from "@aialra-kimi/protocol";
import { WebSocket, WebSocketServer } from "ws";
import type { AuthService, Principal } from "./auth.js";
import { CSRF_COOKIE, SESSION_COOKIE } from "./auth.js";
import type { AppConfig } from "./config.js";
import type { GrantSigner } from "./crypto.js";
import type { ControlPlaneDatabase } from "./database.js";

interface AgentConnection {
  socket: WebSocket;
  hostId: string;
  authenticated: boolean;
  loginState: LoginState;
}

interface BrowserConnection {
  socket: WebSocket;
  principal: Principal;
  channels: Map<
    string,
    {
      hostId: string;
      grant: string;
      grantId: string;
      channel: string;
      openRequestId: string;
      lastSequence: number;
    }
  >;
  /**
   * A failed browser handshake still needs a narrowly scoped online wake-up
   * so a cold-starting agent can be retried without waiting for the full
   * backoff interval.  Watches expire and are removed with the browser socket
   * so they cannot become an unbounded host index.
   */
  hostWatches: Map<string, ReturnType<typeof setTimeout>>;
}

// A 5 MiB attachment expands through JSON base64 and encrypted framing
// Keep a hard bound so media works without creating an unbounded relay
const MAX_FRAME_BYTES = 12 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_AGENT_CONNECTIONS = 128;
const MAX_BROWSER_CONNECTIONS = 16;
const MAX_CHANNELS_PER_BROWSER = 8;
const MAX_HOST_WATCHES_PER_BROWSER = 32;
const HOST_WATCH_TTL_MS = 30_000;
const MAX_HANDSHAKES_PER_MINUTE = 600;
const MAX_AGENT_MESSAGES_PER_TEN_SECONDS = 3_000;
const MAX_BROWSER_MESSAGES_PER_TEN_SECONDS = 600;

export interface RateWindow {
  startedAt: number;
  count: number;
}

export function consumeRate(
  window: RateWindow,
  maximum: number,
  durationMs: number,
  now = Date.now(),
): boolean {
  if (now - window.startedAt >= durationMs) {
    window.startedAt = now;
    window.count = 0;
  }
  window.count += 1;
  return window.count <= maximum;
}

export function parseCookies(
  value: string | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of value?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    try {
      result[part.slice(0, index).trim()] = decodeURIComponent(
        part.slice(index + 1).trim(),
      );
    } catch {
      // Ignore a malformed cookie rather than letting an upgrade request terminate the process.
    }
  }
  return result;
}

function send(socket: WebSocket, payload: unknown): void {
  if (
    socket.readyState !== WebSocket.OPEN ||
    socket.bufferedAmount > MAX_BUFFERED_BYTES
  ) {
    socket.close(1013, "relay backpressure");
    return;
  }
  socket.send(JSON.stringify(payload));
}

function rawDataBytes(data: import("ws").RawData): number {
  return Array.isArray(data)
    ? data.reduce((total, item) => total + item.byteLength, 0)
    : data.byteLength;
}

export class RelayService {
  private readonly agentServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
  });
  private readonly browserServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
  });
  private readonly agents = new Map<string, AgentConnection>();
  private readonly loginStates = new Map<string, LoginState>();
  private readonly browsers = new Set<BrowserConnection>();
  private readonly expectedOpenApi: string;
  private readonly expectedAsyncApi: string;
  private readonly agentHandshakeRate: RateWindow = {
    startedAt: Date.now(),
    count: 0,
  };
  private readonly browserHandshakeRate: RateWindow = {
    startedAt: Date.now(),
    count: 0,
  };

  constructor(
    private readonly config: AppConfig,
    private readonly db: ControlPlaneDatabase,
    private readonly auth: AuthService,
    private readonly signer: GrantSigner,
    upstreamLock: {
      protocol: { openapiSha256: string; asyncapiSha256: string };
    },
  ) {
    this.expectedOpenApi = upstreamLock.protocol.openapiSha256;
    this.expectedAsyncApi = upstreamLock.protocol.asyncapiSha256;
    this.agentServer.on("connection", (socket) => this.handleAgent(socket));
    this.browserServer.on(
      "connection",
      (socket, request) => void this.handleBrowser(socket, request),
    );
  }

  handleUpgrade(
    request: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ): boolean {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", this.config.publicOrigin);
    } catch {
      socket.destroy();
      return true;
    }
    if (url.pathname === "/ws/v1/agent") {
      if (
        !consumeRate(
          this.agentHandshakeRate,
          MAX_HANDSHAKES_PER_MINUTE,
          60_000,
        ) ||
        this.agentServer.clients.size >= MAX_AGENT_CONNECTIONS
      ) {
        socket.destroy();
        return true;
      }
      this.agentServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.agentServer.emit("connection", webSocket, request);
      });
      return true;
    }
    if (url.pathname === "/ws/v1/browser") {
      if (
        !consumeRate(
          this.browserHandshakeRate,
          MAX_HANDSHAKES_PER_MINUTE,
          60_000,
        ) ||
        this.browserServer.clients.size >= MAX_BROWSER_CONNECTIONS
      ) {
        socket.destroy();
        return true;
      }
      if (request.headers.origin !== this.config.publicOrigin.origin) {
        socket.destroy();
        return true;
      }
      const cookies = parseCookies(request.headers.cookie);
      if (
        !cookies[CSRF_COOKIE] ||
        cookies[CSRF_COOKIE] !== url.searchParams.get("csrf")
      ) {
        socket.destroy();
        return true;
      }
      this.browserServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.browserServer.emit("connection", webSocket, request);
      });
      return true;
    }
    return false;
  }

  close(): void {
    for (const connection of this.agents.values())
      connection.socket.close(1001, "server shutdown");
    for (const connection of this.browsers)
      connection.socket.close(1001, "server shutdown");
    this.loginStates.clear();
    this.agentServer.close();
    this.browserServer.close();
  }

  revokeHost(hostId: string): void {
    const connection = this.agents.get(hostId);
    if (connection) connection.socket.close(4003, "host identity revoked");
    this.agents.delete(hostId);
    this.loginStates.delete(hostId);
    this.broadcast({ type: "server.host.offline", hostId });
    this.broadcast({
      type: "server.host.status",
      hostId,
      state: "offline",
      loginState: "unknown",
      kimiVersion: null,
    });
  }

  listHosts(): HostDescriptor[] {
    return this.db.listHosts().map((host) => ({
      ...host,
      loginState: this.loginStates.get(host.hostId) ?? "unknown",
    }));
  }

  private handleAgent(socket: WebSocket): void {
    let connection: AgentConnection | null = null;
    const messageRate: RateWindow = { startedAt: Date.now(), count: 0 };
    const authTimer = setTimeout(
      () => socket.close(1008, "authentication timeout"),
      10_000,
    );
    socket.on("message", (data, binary) => {
      if (
        !consumeRate(messageRate, MAX_AGENT_MESSAGES_PER_TEN_SECONDS, 10_000)
      ) {
        return socket.close(1008, "relay message rate exceeded");
      }
      if (binary || rawDataBytes(data) > MAX_FRAME_BYTES)
        return socket.close(1009, "invalid frame");
      let envelope: AgentEnvelope;
      try {
        envelope = AgentEnvelopeSchema.parse(JSON.parse(data.toString()));
      } catch {
        return socket.close(1007, "invalid envelope");
      }
      if (!connection) {
        if (envelope.type === "agent.enroll") {
          const pairing = this.db.consumePairingCode(envelope.code);
          if (!pairing) return socket.close(1008, "invalid pairing code");
          const hostId = `host_${randomUUID()}`;
          this.db.registerHost({
            hostId,
            displayName: pairing.displayName,
            mode: pairing.mode,
            platform: envelope.platform,
            publicKey: envelope.publicKey,
            agentVersion: envelope.agentVersion,
          });
          send(socket, {
            type: "server.enrolled",
            requestId: envelope.requestId,
            hostId,
            grantVerificationKey: this.signer.publicKeyPem,
          });
          return socket.close(1000, "enrollment complete");
        }
        if (
          envelope.type !== "agent.hello" ||
          !this.verifyAgentHello(envelope)
        ) {
          return socket.close(1008, "agent authentication failed");
        }
        const compatible =
          envelope.openapiSha256 === this.expectedOpenApi &&
          envelope.asyncapiSha256 === this.expectedAsyncApi;
        connection = {
          socket,
          hostId: envelope.hostId,
          authenticated: true,
          loginState: envelope.loginState,
        };
        this.replaceAgent(connection);
        const state: HostState = compatible ? "online" : "unsupported";
        this.db.updateHostStatus({
          hostId: envelope.hostId,
          state,
          agentVersion: envelope.agentVersion,
          kimiVersion: envelope.kimiVersion,
          capabilities: envelope.capabilities,
        });
        this.broadcast({
          type: "server.host.status",
          hostId: envelope.hostId,
          state,
          loginState: envelope.loginState,
          kimiVersion: envelope.kimiVersion,
        });
        clearTimeout(authTimer);
        send(socket, {
          type: "server.hello",
          requestId: envelope.requestId,
          hostId: envelope.hostId,
          compatible,
          expected: {
            openapiSha256: this.expectedOpenApi,
            asyncapiSha256: this.expectedAsyncApi,
          },
        });
        return;
      }
      this.handleAuthenticatedAgent(connection, envelope);
    });
    socket.on("close", () => {
      clearTimeout(authTimer);
      if (connection && this.agents.get(connection.hostId)?.socket === socket) {
        this.agents.delete(connection.hostId);
        this.loginStates.delete(connection.hostId);
        this.db.markHostOffline(connection.hostId);
        this.broadcast({
          type: "server.host.offline",
          hostId: connection.hostId,
        });
        this.broadcast({
          type: "server.host.status",
          hostId: connection.hostId,
          state: "offline",
          loginState: "unknown",
          kimiVersion: null,
        });
      }
    });
  }

  private handleAuthenticatedAgent(
    connection: AgentConnection,
    envelope: AgentEnvelope,
  ): void {
    if (
      "hostId" in envelope &&
      envelope.hostId &&
      envelope.hostId !== connection.hostId
    ) {
      return connection.socket.close(1008, "host identity mismatch");
    }
    if (envelope.type === "agent.heartbeat") {
      connection.loginState = envelope.loginState;
      this.loginStates.set(connection.hostId, envelope.loginState);
      const current = this.db
        .listHosts()
        .find((host) => host.hostId === connection.hostId);
      const state: HostState =
        current?.state === "unsupported" ? "unsupported" : envelope.state;
      this.db.updateHostStatus({
        hostId: connection.hostId,
        state,
        agentVersion: current?.agentVersion ?? "unknown",
        kimiVersion: envelope.kimiVersion,
        capabilities: current?.capabilities ?? [],
      });
      this.broadcast({
        type: "server.host.status",
        hostId: connection.hostId,
        state,
        loginState: envelope.loginState,
        kimiVersion: envelope.kimiVersion,
      });
      send(connection.socket, {
        type: "server.heartbeat",
        sequence: envelope.sequence,
      });
      return;
    }
    if (envelope.type === "agent.session-cache") {
      this.db.replaceSessionCache(connection.hostId, envelope.sessions);
      return;
    }
    if (envelope.type === "agent.audit") {
      const browser = [...this.browsers].find(
        (candidate) =>
          candidate.channels.get(envelope.channelId)?.hostId ===
          connection.hostId,
      );
      if (!browser) return;
      this.db.audit({
        occurredAt: envelope.occurredAt,
        subject: browser.principal.subject,
        hostId: connection.hostId,
        category: envelope.category,
        outcome: envelope.outcome,
        requestId: envelope.requestId,
      });
      return;
    }
    if (envelope.type === "agent.error") {
      let target: BrowserConnection | undefined;
      let targetChannelId: string | undefined;
      if (envelope.requestId) {
        for (const candidate of this.browsers) {
          const match = [...candidate.channels.entries()].find(
            ([, channel]) =>
              channel.hostId === connection.hostId &&
              channel.openRequestId === envelope.requestId,
          );
          if (match) {
            target = candidate;
            targetChannelId = match[0];
            break;
          }
        }
      }
      if (!target && envelope.channelId) {
        for (const candidate of this.browsers) {
          const channel = candidate.channels.get(envelope.channelId);
          if (channel?.hostId === connection.hostId) {
            target = candidate;
            targetChannelId = envelope.channelId;
            break;
          }
        }
      }
      if (!target || !targetChannelId) return;
      if (envelope.channelId && targetChannelId !== envelope.channelId) return;
      target.channels.delete(targetChannelId);
      send(target.socket, {
        type: "server.error",
        ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
        channelId: targetChannelId,
        code: envelope.code,
        message: envelope.message,
      });
      return;
    }
    if (
      envelope.type === "agent.channel.accept" ||
      envelope.type === "agent.frame"
    ) {
      return this.broadcast(envelope, connection.hostId);
    }
  }

  private async handleBrowser(
    socket: WebSocket,
    request: IncomingMessage,
  ): Promise<void> {
    const cookies = parseCookies(request.headers.cookie);
    const principal = await this.auth.sessionFromToken(cookies[SESSION_COOKIE]);
    if (!principal) return socket.close(1008, "authentication required");
    const connection: BrowserConnection = {
      socket,
      principal,
      channels: new Map(),
      hostWatches: new Map(),
    };
    const messageRate: RateWindow = { startedAt: Date.now(), count: 0 };
    this.browsers.add(connection);
    send(socket, { type: "server.browser.ready" });
    socket.on("message", (data, binary) => {
      if (
        !consumeRate(messageRate, MAX_BROWSER_MESSAGES_PER_TEN_SECONDS, 10_000)
      ) {
        return socket.close(1008, "relay message rate exceeded");
      }
      if (binary || rawDataBytes(data) > MAX_FRAME_BYTES)
        return socket.close(1009, "invalid frame");
      let envelope;
      try {
        envelope = BrowserEnvelopeSchema.parse(JSON.parse(data.toString()));
      } catch {
        return socket.close(1007, "invalid envelope");
      }
      if (envelope.type === "browser.channel.open") {
        if (
          connection.channels.has(envelope.channelId) ||
          connection.channels.size >= MAX_CHANNELS_PER_BROWSER
        ) {
          return send(socket, {
            type: "server.error",
            requestId: envelope.requestId,
            code: "channel_limit_reached",
          });
        }
        let grant;
        try {
          grant = this.signer.verify(envelope.grant);
        } catch {
          return send(socket, {
            type: "server.error",
            requestId: envelope.requestId,
            code: "invalid_grant",
          });
        }
        if (
          grant.subject !== principal.subject ||
          grant.hostId !== envelope.hostId
        ) {
          return send(socket, {
            type: "server.error",
            requestId: envelope.requestId,
            code: "grant_binding_mismatch",
          });
        }
        const allowed =
          (envelope.channel === "kimi" &&
            grant.scopes.some((scope) => !scope.startsWith("terminal."))) ||
          (envelope.channel === "terminal" &&
            grant.scopes.some(
              (scope) =>
                scope.startsWith("terminal.") &&
                !scope.startsWith("terminal.elevate."),
            )) ||
          (envelope.channel === "elevated-terminal" &&
            grant.scopes.some((scope) =>
              scope.startsWith("terminal.elevate."),
            ));
        if (
          !allowed ||
          !this.db.consumeNonce(grant.nonce, new Date(grant.expiresAt * 1000))
        ) {
          return send(socket, {
            type: "server.error",
            requestId: envelope.requestId,
            code: "grant_rejected",
          });
        }
        this.watchHost(connection, envelope.hostId);
        connection.channels.set(envelope.channelId, {
          hostId: envelope.hostId,
          grant: envelope.grant,
          grantId: grant.grantId,
          channel: envelope.channel,
          openRequestId: envelope.requestId,
          lastSequence: -1,
        });
      } else if (envelope.type === "browser.frame") {
        const channel = connection.channels.get(envelope.frame.channelId);
        if (
          !channel ||
          channel.hostId !== envelope.hostId ||
          channel.grant !== envelope.grant ||
          channel.channel !== envelope.frame.channel ||
          envelope.frame.sequence <= channel.lastSequence
        ) {
          return send(socket, {
            type: "server.error",
            channelId: envelope.frame.channelId,
            code: "channel_validation_failed",
          });
        }
        channel.lastSequence = envelope.frame.sequence;
      } else {
        const channel = connection.channels.get(envelope.channelId);
        if (!channel || channel.hostId !== envelope.hostId) return;
        connection.channels.delete(envelope.channelId);
      }
      const agent = this.agents.get(envelope.hostId);
      if (!agent) {
        if (envelope.type === "browser.channel.close") return;
        if (envelope.type === "browser.channel.open")
          connection.channels.delete(envelope.channelId);
        return send(socket, {
          type: "server.error",
          requestId:
            envelope.type === "browser.channel.open"
              ? envelope.requestId
              : undefined,
          code: "host_offline",
        });
      }
      send(agent.socket, { ...envelope, subject: principal.subject });
    });
    socket.on("close", () => {
      this.browsers.delete(connection);
      for (const timer of connection.hostWatches.values()) clearTimeout(timer);
      connection.hostWatches.clear();
      for (const [channelId, channel] of connection.channels) {
        const agent = this.agents.get(channel.hostId);
        if (agent)
          send(agent.socket, {
            type: "browser.channel.close",
            hostId: channel.hostId,
            channelId,
            reason: "disconnect",
          });
      }
    });
  }

  private verifyAgentHello(
    envelope: Extract<AgentEnvelope, { type: "agent.hello" }>,
  ): boolean {
    const identity = this.db.getHostIdentity(envelope.hostId);
    if (
      !identity ||
      identity.revoked ||
      Math.abs(Date.now() - envelope.timestamp) > 60_000
    )
      return false;
    if (!this.db.consumeNonce(envelope.nonce, new Date(Date.now() + 120_000)))
      return false;
    const canonical = [
      envelope.hostId,
      envelope.timestamp,
      envelope.nonce,
      envelope.agentVersion,
      envelope.kimiVersion ?? "",
      envelope.openapiSha256 ?? "",
      envelope.asyncapiSha256 ?? "",
      envelope.loginState,
      envelope.capabilities.join(","),
    ].join("\n");
    try {
      return verify(
        null,
        Buffer.from(canonical),
        createPublicKey(identity.publicKey),
        Buffer.from(envelope.signature, "base64url"),
      );
    } catch {
      return false;
    }
  }

  private replaceAgent(connection: AgentConnection): void {
    const previous = this.agents.get(connection.hostId);
    if (previous) previous.socket.close(4001, "replaced by a newer connection");
    this.agents.set(connection.hostId, connection);
    this.loginStates.set(connection.hostId, connection.loginState);
    this.broadcast({ type: "server.host.online", hostId: connection.hostId });
  }

  private broadcast(payload: unknown, hostId?: string): void {
    for (const browser of this.browsers) {
      if (
        !hostId ||
        browser.hostWatches.has(hostId) ||
        [...browser.channels.values()].some(
          (channel) => channel.hostId === hostId,
        )
      ) {
        send(browser.socket, payload);
      }
    }
  }

  private watchHost(connection: BrowserConnection, hostId: string): void {
    const previous = connection.hostWatches.get(hostId);
    if (previous) clearTimeout(previous);
    else if (connection.hostWatches.size >= MAX_HOST_WATCHES_PER_BROWSER) {
      const oldest = connection.hostWatches.keys().next().value;
      if (typeof oldest === "string") {
        const timer = connection.hostWatches.get(oldest);
        if (timer) clearTimeout(timer);
        connection.hostWatches.delete(oldest);
      }
    }
    const timer = setTimeout(() => {
      if (connection.hostWatches.get(hostId) === timer)
        connection.hostWatches.delete(hostId);
    }, HOST_WATCH_TTL_MS);
    connection.hostWatches.set(hostId, timer);
  }
}

export function newPairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}
