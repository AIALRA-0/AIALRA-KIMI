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
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  it("waits for the authenticated relay-ready message before opening a channel", async () => {
    const { BrowserRelay } = await import("../src/relay.js");
    const relay = new BrowserRelay();
    const attempt = relay.open(
      "host_windows",
      "kimi",
      ["sessions.list"],
      vi.fn(),
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
    await expect(attempt).rejects.toThrow("主机已离线");
    expect(socket.sent.at(-1)?.type).toBe("browser.channel.close");
  });

  it("discards a cold-start channel and allows an automatic retry", async () => {
    const { BrowserRelay } = await import("../src/relay.js");
    const relay = new BrowserRelay();
    const disconnected = vi.fn();
    const firstAttempt = relay.open(
      "host_windows",
      "kimi",
      ["sessions.list"],
      disconnected,
    );
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    socket.message({ type: "server.browser.ready" });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    socket.message({ type: "server.host.offline", hostId: "host_windows" });
    await expect(firstAttempt).rejects.toThrow("主机已离线");
    expect(disconnected).toHaveBeenCalledWith({ type: "channel.disconnected" });

    const secondAttempt = relay.open(
      "host_windows",
      "kimi",
      ["sessions.list"],
      vi.fn(),
    );
    await vi.waitFor(() =>
      expect(
        socket.sent.filter(
          (message) => message.type === "browser.channel.open",
        ),
      ).toHaveLength(2),
    );
    const secondOpen = socket.sent.findLast(
      (message) => message.type === "browser.channel.open",
    )!;
    socket.message({
      type: "server.error",
      requestId: secondOpen.requestId,
      code: "host_offline",
    });
    await expect(secondAttempt).rejects.toThrow("主机已离线");
  });
});
