import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import {
  AGENT_OPERATIONS,
  HostModeSchema,
  PermissionModeSchema,
} from "@aialra-kimi/protocol";
import upstreamLock from "../../../upstream.lock.json" with { type: "json" };
import { AuthService } from "./auth.js";
import type { AppConfig } from "./config.js";
import { GrantSigner } from "./crypto.js";
import { ControlPlaneDatabase } from "./database.js";
import { newPairingCode, RelayService } from "./relay.js";

const PairingBody = z.object({
  displayName: z.string().min(1).max(120),
  mode: HostModeSchema,
});

const RelayGrantBody = z.object({
  hostId: z.string().min(8).max(128),
  scopes: z.array(z.enum(AGENT_OPERATIONS)).min(1).max(32),
  ttlSeconds: z.number().int().min(15).max(300).default(60),
});

const HostPreferencesBody = z.object({
  defaultPermissionMode: PermissionModeSchema,
});

export interface AppServices {
  app: FastifyInstance;
  db: ControlPlaneDatabase;
  relay: RelayService;
  close(): Promise<void>;
}

export async function createApp(config: AppConfig): Promise<AppServices> {
  const app = Fastify({
    logger: {
      level: config.nodeEnv === "test" ? "silent" : "info",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.body",
          "res.headers.set-cookie",
        ],
        censor: "[REDACTED]",
      },
    },
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
  });
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // xterm creates runtime style elements for character measurements and themes.
        // Scripts remain nonce-free and self-only; only CSS is allowed inline.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: [
          "'self'",
          config.publicOrigin.origin.replace(/^http/, "ws"),
        ],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.nodeEnv === "production",
  });
  await app.register(rateLimit, {
    max: 180,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.ip,
  });

  const db = new ControlPlaneDatabase(config.databasePath, config.databaseKey);
  const auth = new AuthService(config);
  const signer = new GrantSigner(config.grantSigningPrivateKey);
  const relay = new RelayService(config, db, auth, signer, upstreamLock);
  await auth.registerRoutes(app);

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => ({
    status: "ok",
    upstreamVersion: upstreamLock.version,
    protocol: upstreamLock.protocol,
  }));

  app.get("/api/v1/me", async (request, reply) => {
    const principal = await auth.requireOwner(request, reply);
    if (!principal) return;
    if (!request.cookies.aialra_csrf) {
      reply.setCookie("aialra_csrf", randomBytes(24).toString("base64url"), {
        path: "/",
        httpOnly: false,
        secure: config.nodeEnv === "production",
        sameSite: "lax",
        maxAge: 28_800,
      });
    }
    return { subject: principal.subject, displayName: principal.displayName };
  });

  app.get("/api/v1/hosts", async (request, reply) => {
    if (!(await auth.requireOwner(request, reply))) return;
    return { hosts: db.listHosts() };
  });

  app.post("/api/v1/pairing-codes", async (request, reply) => {
    const principal = await auth.requireOwner(request, reply);
    if (!principal || !auth.verifyCsrf(request, reply)) return;
    const body = PairingBody.parse(request.body);
    const code = newPairingCode();
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    db.storePairingCode(code, body.displayName, body.mode, expiresAt);
    db.audit({
      subject: principal.subject,
      category: "agent_pairing_code",
      outcome: "issued",
      requestId: request.id,
    });
    return reply.code(201).send({ code, expiresAt: expiresAt.toISOString() });
  });

  app.get("/api/v1/hosts/:hostId/session-cache", async (request, reply) => {
    if (!(await auth.requireOwner(request, reply))) return;
    const { hostId } = z
      .object({ hostId: z.string().min(8).max(128) })
      .parse(request.params);
    const host = db
      .listHosts()
      .find((candidate) => candidate.hostId === hostId);
    if (!host) return reply.code(404).send({ error: "host_not_found" });
    return {
      hostId,
      availableOffline: host.state === "offline",
      sessions: db.getSessionCache(hostId),
    };
  });

  app.get("/api/v1/hosts/:hostId/preferences", async (request, reply) => {
    if (!(await auth.requireOwner(request, reply))) return;
    const { hostId } = z
      .object({ hostId: z.string().min(8).max(128) })
      .parse(request.params);
    const preferences = db.getHostPreferences(hostId);
    return preferences ?? reply.code(404).send({ error: "host_not_found" });
  });

  app.put("/api/v1/hosts/:hostId/preferences", async (request, reply) => {
    const principal = await auth.requireOwner(request, reply);
    if (!principal || !auth.verifyCsrf(request, reply)) return;
    const { hostId } = z
      .object({ hostId: z.string().min(8).max(128) })
      .parse(request.params);
    const body = HostPreferencesBody.parse(request.body);
    if (!db.setHostPreferences(hostId, body.defaultPermissionMode)) {
      return reply.code(404).send({ error: "host_not_found" });
    }
    db.audit({
      subject: principal.subject,
      hostId,
      category: "host_preferences",
      outcome: "succeeded",
      requestId: request.id,
    });
    return body;
  });

  app.get("/api/v1/elevation/status", async (request, reply) => {
    const principal = await auth.requireOwner(request, reply);
    if (!principal) return;
    const expiresAt = await auth.elevationStatus(request, principal);
    return {
      elevated: expiresAt !== null,
      expiresAt:
        expiresAt === null ? null : new Date(expiresAt * 1000).toISOString(),
    };
  });

  app.post("/api/v1/relay-grants", async (request, reply) => {
    const principal = await auth.requireOwner(request, reply);
    if (!principal || !auth.verifyCsrf(request, reply)) return;
    const body = RelayGrantBody.parse(request.body);
    if (
      body.scopes.some((scope) => scope.startsWith("terminal.elevate.")) &&
      !(await auth.requireElevation(request, reply, principal))
    ) {
      return;
    }
    const host = db
      .listHosts()
      .find((candidate) => candidate.hostId === body.hostId);
    if (!host) return reply.code(404).send({ error: "host_not_found" });
    if (host.state === "offline" || host.state === "unsupported") {
      return reply.code(409).send({ error: `host_${host.state}` });
    }
    const now = Math.floor(Date.now() / 1000);
    const token = signer.issue({
      grantId: randomUUID(),
      subject: principal.subject,
      hostId: body.hostId,
      scopes: body.scopes,
      issuedAt: now,
      expiresAt: now + body.ttlSeconds,
      nonce: randomBytes(24).toString("base64url"),
    });
    db.audit({
      subject: principal.subject,
      hostId: body.hostId,
      category: "relay_grant",
      outcome: "issued",
      requestId: request.id,
    });
    return {
      token,
      expiresAt: new Date((now + body.ttlSeconds) * 1000).toISOString(),
    };
  });

  app.get("/api/v1/agent-verification-key", async (request, reply) => {
    if (!(await auth.requireOwner(request, reply))) return;
    return { algorithm: "Ed25519", publicKeyPem: signer.publicKeyPem };
  });

  app.get("/api/v1/hosts/:hostId/identity", async (request, reply) => {
    if (!(await auth.requireOwner(request, reply))) return;
    const { hostId } = z
      .object({ hostId: z.string().min(8).max(128) })
      .parse(request.params);
    const identity = db.getHostIdentity(hostId);
    if (!identity || identity.revoked)
      return reply.code(404).send({ error: "host_not_found" });
    return { hostId, algorithm: "Ed25519", publicKeyPem: identity.publicKey };
  });

  app.post("/api/v1/hosts/:hostId/revoke", async (request, reply) => {
    const principal = await auth.requireOwner(request, reply);
    if (!principal || !auth.verifyCsrf(request, reply)) return;
    const { hostId } = z
      .object({ hostId: z.string().min(8).max(128) })
      .parse(request.params);
    if (!db.revokeHost(hostId)) {
      return reply.code(404).send({ error: "host_not_found" });
    }
    relay.revokeHost(hostId);
    db.audit({
      subject: principal.subject,
      hostId,
      category: "agent_revoke",
      outcome: "succeeded",
      requestId: request.id,
    });
    return reply.code(204).send();
  });

  if (existsSync(config.webDistPath)) {
    await app.register(fastifyStatic, {
      root: config.webDistPath,
      wildcard: false,
    });
    app.get("/*", async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
      return reply
        .type("text/html")
        .send(readFileSync(join(config.webDistPath, "index.html")));
    });
  }

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Pragma", "no-cache");
    return payload;
  });

  app.server.on("upgrade", (request, socket, head) => {
    if (!relay.handleUpgrade(request, socket, head)) socket.destroy();
  });

  return {
    app,
    db,
    relay,
    async close() {
      relay.close();
      await app.close();
      db.close();
    },
  };
}
