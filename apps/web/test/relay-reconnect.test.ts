import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api.js", () => ({
  api: {
    grant: vi.fn(async () => ({ token: "grant-token" })),
    identity: vi.fn(async () => ({
      publicKeyPem: `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(32)))}\n-----END PUBLIC KEY-----`,
    })),
  },
  csrfToken: vi.fn(() => "csrf-token"),
}));

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly sent: Array<Record<string, unknown>> = [];
  readyState = MockWebSocket.CONNECTING;
  private readonly listeners = new Map<string, Set<(event: any) => void>>();

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: (event: any) => void,
    options?: { once?: boolean },
  ): void {
    const wrapped = options?.once
      ? (event: any) => {
          this.listeners.get(type)?.delete(wrapped);
          listener(event);
        }
      : listener;
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(wrapped);
    this.listeners.set(type, listeners);
  }

  send(value: string): void {
    this.sent.push(JSON.parse(value) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", {});
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", {});
  }

  message(value: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(value) });
  }

  private emit(type: string, event: any): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

describe("browser relay recovery", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.clearAllMocks();
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  it("waits for relay-ready and retries with a fresh grant after a cold start", async () => {
    const { BrowserRelay } = await import("../src/relay.js");
    const { api } = await import("../src/api.js");
    const relay = new BrowserRelay();
    const controller = new AbortController();
    const attempt = relay.open(
      "host_windows",
      "kimi",
      ["sessions.list"],
      vi.fn(),
      controller.signal,
    );
    const socket = MockWebSocket.instances[0]!;

    socket.open();
    await Promise.resolve();
    expect(socket.sent).toHaveLength(0);

    socket.message({ type: "server.browser.ready" });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const request = socket.sent[0]!;
    expect(request.type).toBe("browser.channel.open");

    socket.message({
      type: "server.error",
      requestId: request.requestId,
      code: "host_offline",
    });
    await vi.waitFor(() =>
      expect(
        socket.sent.filter(
          (message) => message.type === "browser.channel.open",
        ),
      ).toHaveLength(2),
    );
    const retry = socket.sent.findLast(
      (message) => message.type === "browser.channel.open",
    )!;
    expect(retry.channelId).not.toBe(request.channelId);
    expect(api.grant).toHaveBeenCalledTimes(2);
    controller.abort();
    await expect(attempt).rejects.toThrow("中继连接已取消");
  });

  it("wakes a pending retry when the selected host comes online", async () => {
    const { BrowserRelay } = await import("../src/relay.js");
    const relay = new BrowserRelay();
    const disconnected = vi.fn();
    const controller = new AbortController();
    const firstAttempt = relay.open(
      "host_windows",
      "kimi",
      ["sessions.list"],
      disconnected,
      controller.signal,
    );
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    socket.message({ type: "server.browser.ready" });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    socket.message({ type: "server.host.offline", hostId: "host_windows" });
    expect(disconnected).toHaveBeenCalledWith({ type: "channel.disconnected" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      socket.sent.filter((message) => message.type === "browser.channel.open"),
    ).toHaveLength(1);
    socket.message({ type: "server.host.online", hostId: "host_windows" });
    await vi.waitFor(() =>
      expect(
        socket.sent.filter(
          (message) => message.type === "browser.channel.open",
        ),
      ).toHaveLength(2),
    );
    controller.abort();
    await expect(firstAttempt).rejects.toThrow("中继连接已取消");
  });

  it("bounds transcript recovery retries with jitter", async () => {
    const { transcriptRetryDelay } = await import("../src/recovery-policy.js");
    expect(transcriptRetryDelay(0, () => 0)).toBe(325);
    expect(transcriptRetryDelay(0, () => 1)).toBe(500);
    expect(transcriptRetryDelay(20, () => 0)).toBe(9_750);
    expect(transcriptRetryDelay(20, () => 1)).toBe(15_000);
  });

  it("uses an eager bounded relay backoff", async () => {
    const { relayRetryDelay } = await import("../src/recovery-policy.js");
    expect(relayRetryDelay(0, () => 0)).toBe(188);
    expect(relayRetryDelay(0, () => 1)).toBe(250);
    expect(relayRetryDelay(20, () => 0)).toBe(11_250);
    expect(relayRetryDelay(20, () => 1)).toBe(15_000);
  });
});
