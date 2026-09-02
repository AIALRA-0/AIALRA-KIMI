import { z } from "zod";
import { AGENT_OPERATIONS } from "./operations.js";

export const HOST_MODES = ["vps", "remote"] as const;
export const HOST_STATES = [
  "online",
  "degraded",
  "offline",
  "unsupported",
] as const;
export const PERMISSION_MODES = ["manual", "auto", "yolo"] as const;

export const HostModeSchema = z.enum(HOST_MODES);
export const HostStateSchema = z.enum(HOST_STATES);
export const PermissionModeSchema = z.enum(PERMISSION_MODES);

export type HostMode = z.infer<typeof HostModeSchema>;
export type HostState = z.infer<typeof HostStateSchema>;
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const HostSessionRefSchema = z.object({
  hostId: z.string().min(8).max(128),
  upstreamSessionId: z.string().min(1).max(512),
});

export type HostSessionRef = z.infer<typeof HostSessionRefSchema>;

export const UsageWindowSchema = z.object({
  label: z.string().min(1),
  used: z.number().nonnegative(),
  limit: z.number().positive().nullable(),
  resetAt: z.string().datetime().nullable(),
  unit: z.string().min(1),
});

export const UsageSnapshotSchema = z.object({
  accountLabel: z.string().min(1),
  planLabel: z.string().nullable(),
  windows: z.array(UsageWindowSchema),
  extraUsage: z.number().nonnegative().nullable(),
  capturedAt: z.string().datetime(),
  upstreamError: z.string().nullable(),
});

export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;

export const CapabilityGrantSchema = z.object({
  grantId: z.string().uuid(),
  subject: z.string().min(1),
  hostId: z.string().min(8).max(128),
  scopes: z.array(z.enum(AGENT_OPERATIONS)).min(1),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  nonce: z.string().min(22).max(128),
});

export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>;

export const ChannelKindSchema = z.enum([
  "kimi",
  "terminal",
  "elevated-terminal",
]);

export const EncryptedChannelFrameSchema = z.object({
  channelId: z.string().uuid(),
  channel: ChannelKindSchema,
  sequence: z.number().int().nonnegative(),
  nonce: z.string().min(32).max(64),
  ciphertext: z.string().min(1),
  tag: z.string().min(16).max(64),
});

export type EncryptedChannelFrame = z.infer<typeof EncryptedChannelFrameSchema>;

export const HostDescriptorSchema = z.object({
  hostId: z.string().min(8).max(128),
  displayName: z.string().min(1).max(120),
  mode: HostModeSchema,
  state: HostStateSchema,
  platform: z.enum(["windows", "linux"]),
  agentVersion: z.string().min(1),
  kimiVersion: z.string().nullable(),
  lastSeenAt: z.string().datetime().nullable(),
  capabilities: z.array(z.string()),
});

export type HostDescriptor = z.infer<typeof HostDescriptorSchema>;

export const SessionCacheItemSchema = z.object({
  hostId: z.string().min(8).max(128),
  upstreamSessionId: z.string().min(1).max(512),
  title: z.string().min(1).max(240),
  workspaceAlias: z.string().min(1).max(120),
  updatedAt: z.string().datetime(),
  state: z.enum(["idle", "running", "waiting", "error"]),
});

export type SessionCacheItem = z.infer<typeof SessionCacheItemSchema>;

export const AgentEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agent.enroll"),
    requestId: z.string().uuid(),
    code: z.string().regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/),
    publicKey: z.string().min(40).max(128),
    displayName: z.string().min(1).max(120),
    mode: HostModeSchema,
    platform: z.enum(["windows", "linux"]),
    agentVersion: z.string().min(1),
  }),
  z.object({
    type: z.literal("agent.hello"),
    requestId: z.string().uuid(),
    hostId: z.string().min(8).max(128),
    timestamp: z.number().int().positive(),
    nonce: z.string().min(22).max(128),
    signature: z.string().min(64).max(256),
    agentVersion: z.string().min(1),
    kimiVersion: z.string().nullable(),
    openapiSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    asyncapiSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    capabilities: z.array(z.string().min(1).max(80)).max(64),
  }),
  z.object({
    type: z.literal("agent.heartbeat"),
    hostId: z.string().min(8).max(128),
    sequence: z.number().int().nonnegative(),
    state: z.enum(["online", "degraded"]),
    kimiVersion: z.string().nullable(),
    loginState: z.enum(["authenticated", "unauthenticated", "unknown"]),
  }),
  z.object({
    type: z.literal("agent.session-cache"),
    hostId: z.string().min(8).max(128),
    generatedAt: z.string().datetime(),
    sessions: z.array(SessionCacheItemSchema).max(10_000),
  }),
  z.object({
    type: z.literal("agent.audit"),
    hostId: z.string().min(8).max(128),
    channelId: z.string().uuid(),
    requestId: z.string().uuid(),
    category: z.enum(AGENT_OPERATIONS),
    outcome: z.enum(["started", "succeeded", "failed"]),
    occurredAt: z.string().datetime(),
  }),
  z.object({
    type: z.literal("agent.channel.accept"),
    requestId: z.string().uuid(),
    hostId: z.string().min(8).max(128),
    channelId: z.string().uuid(),
    agentEphemeralKey: z.string().min(40).max(128),
    signature: z.string().min(64).max(256),
  }),
  z.object({
    type: z.literal("agent.frame"),
    hostId: z.string().min(8).max(128),
    frame: EncryptedChannelFrameSchema,
  }),
  z.object({
    type: z.literal("agent.error"),
    requestId: z.string().uuid().nullable(),
    hostId: z.string().min(8).max(128).nullable(),
    channelId: z.string().uuid().nullable().optional(),
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(500),
  }),
]);

export type AgentEnvelope = z.infer<typeof AgentEnvelopeSchema>;

export const BrowserEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("browser.channel.open"),
    requestId: z.string().uuid(),
    hostId: z.string().min(8).max(128),
    channelId: z.string().uuid(),
    channel: ChannelKindSchema,
    browserEphemeralKey: z.string().min(40).max(128),
    grant: z.string().min(64),
  }),
  z.object({
    type: z.literal("browser.frame"),
    hostId: z.string().min(8).max(128),
    grant: z.string().min(64),
    frame: EncryptedChannelFrameSchema,
  }),
  z.object({
    type: z.literal("browser.channel.close"),
    hostId: z.string().min(8).max(128),
    channelId: z.string().uuid(),
    reason: z.enum(["user", "disconnect", "expired"]),
  }),
]);

export type BrowserEnvelope = z.infer<typeof BrowserEnvelopeSchema>;
