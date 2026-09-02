import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { EncryptJWT, SignJWT, jwtDecrypt, jwtVerify } from "jose";
import * as oidc from "openid-client";
import type { AppConfig } from "./config.js";

export const SESSION_COOKIE = "aialra_session";
const OIDC_COOKIE = "aialra_oidc";
export const ELEVATION_COOKIE = "aialra_elevated";
const ELEVATION_OIDC_COOKIE = "aialra_elevation_oidc";
export const CSRF_COOKIE = "aialra_csrf";

export interface Principal {
  subject: string;
  displayName: string;
  groups: string[];
}

interface OidcTransaction {
  state: string;
  verifier: string;
  returnTo: string;
  subject?: string;
}

export function safeReturnPath(value: string, publicOrigin: URL): string {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\r\n]/u.test(value)
  ) {
    return "/";
  }
  try {
    const target = new URL(value, publicOrigin);
    return target.origin === publicOrigin.origin
      ? `${target.pathname}${target.search}${target.hash}`
      : "/";
  } catch {
    return "/";
  }
}

function authenticationFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
) {
  return reply.code(status).send({
    error: "authentication_failed",
    requestId: request.id,
  });
}

export class AuthService {
  private discovery: Promise<oidc.Configuration> | null = null;
  private elevationDiscovery: Promise<oidc.Configuration> | null = null;

  constructor(private readonly config: AppConfig) {}

  async sessionFromToken(token: string | undefined): Promise<Principal | null> {
    if (this.config.devAuthBypass && this.config.nodeEnv !== "production") {
      return {
        subject: "development-owner",
        displayName: "Development owner",
        groups: ["owner"],
      };
    }
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.config.sessionKey, {
        algorithms: ["HS256"],
        audience: "aialra-kimi",
        issuer: this.config.publicOrigin.origin,
      });
      const groups = Array.isArray(payload.groups)
        ? payload.groups.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      if (typeof payload.sub !== "string" || typeof payload.name !== "string")
        return null;
      return { subject: payload.sub, displayName: payload.name, groups };
    } catch {
      return null;
    }
  }

  async principal(request: FastifyRequest): Promise<Principal | null> {
    return this.sessionFromToken(request.cookies[SESSION_COOKIE]);
  }

  async requireOwner(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Principal | null> {
    const principal = await this.principal(request);
    if (!principal) {
      await reply.code(401).send({ error: "authentication_required" });
      return null;
    }
    if (
      this.config.oidc &&
      !principal.groups.includes(this.config.oidc.ownerGroup) &&
      principal.subject !== "development-owner"
    ) {
      await reply.code(403).send({ error: "owner_group_required" });
      return null;
    }
    return principal;
  }

  async requireElevation(
    request: FastifyRequest,
    reply: FastifyReply,
    principal: Principal,
  ): Promise<boolean> {
    if (this.config.devAuthBypass && this.config.nodeEnv !== "production")
      return true;
    const token = request.cookies[ELEVATION_COOKIE];
    if (!token) {
      await reply.code(403).send({ error: "recent_elevation_required" });
      return false;
    }
    try {
      const { payload } = await jwtVerify(token, this.config.sessionKey, {
        algorithms: ["HS256"],
        audience: "aialra-kimi-elevation",
        issuer: this.config.publicOrigin.origin,
        subject: principal.subject,
      });
      if (payload.purpose !== "elevation")
        throw new Error("wrong token purpose");
      return true;
    } catch {
      await reply.code(403).send({ error: "recent_elevation_required" });
      return false;
    }
  }

  async elevationStatus(
    request: FastifyRequest,
    principal: Principal,
  ): Promise<number | null> {
    if (this.config.devAuthBypass && this.config.nodeEnv !== "production") {
      return Math.floor(Date.now() / 1000) + 300;
    }
    const token = request.cookies[ELEVATION_COOKIE];
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.config.sessionKey, {
        algorithms: ["HS256"],
        audience: "aialra-kimi-elevation",
        issuer: this.config.publicOrigin.origin,
        subject: principal.subject,
      });
      return payload.purpose === "elevation" && typeof payload.exp === "number"
        ? payload.exp
        : null;
    } catch {
      return null;
    }
  }

  verifyCsrf(request: FastifyRequest, reply: FastifyReply): boolean {
    const expectedOrigin = this.config.publicOrigin.origin;
    const origin = request.headers.origin;
    const token = request.headers["x-csrf-token"];
    const cookie = request.cookies[CSRF_COOKIE];
    if (
      origin !== expectedOrigin ||
      typeof token !== "string" ||
      !cookie ||
      token !== cookie
    ) {
      void reply.code(403).send({ error: "csrf_validation_failed" });
      return false;
    }
    return true;
  }

  async registerRoutes(app: FastifyInstance): Promise<void> {
    app.get("/auth/login", async (request, reply) => {
      if (this.config.devAuthBypass && this.config.nodeEnv !== "production") {
        return reply.redirect("/");
      }
      if (!this.config.oidc) return authenticationFailure(request, reply, 503);
      try {
        const provider = await this.provider();
        const verifier = oidc.randomPKCECodeVerifier();
        const state = oidc.randomState();
        const returnTo = this.safeReturnTo(
          typeof request.query === "object" &&
            request.query &&
            "returnTo" in request.query
            ? String(request.query.returnTo)
            : "/",
        );
        const transaction = await new EncryptJWT({ state, verifier, returnTo })
          .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
          .setIssuedAt()
          .setExpirationTime("10m")
          .encrypt(this.config.sessionKey);
        reply.setCookie(OIDC_COOKIE, transaction, this.cookieOptions(600));
        const url = oidc.buildAuthorizationUrl(provider, {
          redirect_uri: this.config.oidc.redirectUri.href,
          scope: "openid profile email groups",
          code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
          code_challenge_method: "S256",
          state,
          prompt: "login",
          max_age: "0",
        });
        return reply.redirect(url.href);
      } catch {
        return authenticationFailure(request, reply, 503);
      }
    });

    app.get("/auth/callback", async (request, reply) => {
      if (!this.config.oidc) return authenticationFailure(request, reply, 503);
      const encrypted = request.cookies[OIDC_COOKIE];
      if (!encrypted) return authenticationFailure(request, reply, 400);
      let transaction: OidcTransaction;
      try {
        const { payload } = await jwtDecrypt(encrypted, this.config.sessionKey);
        transaction = {
          state: String(payload.state),
          verifier: String(payload.verifier),
          returnTo: this.safeReturnTo(String(payload.returnTo)),
        };
      } catch {
        return authenticationFailure(request, reply, 400);
      }
      const currentUrl = new URL(request.url, this.config.publicOrigin);
      let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
      try {
        tokens = await oidc.authorizationCodeGrant(
          await this.provider(),
          currentUrl,
          {
            pkceCodeVerifier: transaction.verifier,
            expectedState: transaction.state,
          },
        );
      } catch {
        return authenticationFailure(request, reply, 401);
      }
      let claims: ReturnType<typeof tokens.claims>;
      try {
        claims = tokens.claims();
      } catch {
        return authenticationFailure(request, reply, 401);
      }
      if (!claims?.sub) return authenticationFailure(request, reply, 401);
      const rawGroups = claims.groups;
      const groups = Array.isArray(rawGroups)
        ? rawGroups.filter(
            (value): value is string => typeof value === "string",
          )
        : typeof rawGroups === "string"
          ? [rawGroups]
          : [];
      if (!groups.includes(this.config.oidc.ownerGroup)) {
        return authenticationFailure(request, reply, 403);
      }
      const name = typeof claims.name === "string" ? claims.name : claims.sub;
      const session = await new SignJWT({ name, groups })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(claims.sub)
        .setAudience("aialra-kimi")
        .setIssuer(this.config.publicOrigin.origin)
        .setIssuedAt()
        .setExpirationTime("8h")
        .sign(this.config.sessionKey);
      reply.clearCookie(OIDC_COOKIE, this.cookieOptions(0));
      reply.setCookie(SESSION_COOKIE, session, this.cookieOptions(28_800));
      reply.setCookie(CSRF_COOKIE, oidc.randomState(), {
        ...this.cookieOptions(28_800),
        httpOnly: false,
      });
      return reply.redirect(transaction.returnTo);
    });

    app.get("/auth/elevate", async (request, reply) => {
      const principal = await this.requireOwner(request, reply);
      if (!principal) return;
      if (this.config.devAuthBypass && this.config.nodeEnv !== "production") {
        return reply.redirect("/?elevated=1");
      }
      if (!this.config.elevationOidc) {
        return authenticationFailure(request, reply, 503);
      }
      try {
        const verifier = oidc.randomPKCECodeVerifier();
        const state = oidc.randomState();
        const returnTo = this.safeReturnTo(
          typeof request.query === "object" &&
            request.query &&
            "returnTo" in request.query
            ? String(request.query.returnTo)
            : "/?elevated=1",
        );
        const transaction = await new EncryptJWT({
          state,
          verifier,
          returnTo,
          subject: principal.subject,
        })
          .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
          .setIssuedAt()
          .setExpirationTime("10m")
          .encrypt(this.config.sessionKey);
        reply.setCookie(
          ELEVATION_OIDC_COOKIE,
          transaction,
          this.cookieOptions(600),
        );
        const url = oidc.buildAuthorizationUrl(await this.elevationProvider(), {
          redirect_uri: this.config.elevationOidc.redirectUri.href,
          scope: "openid profile email groups",
          code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
          code_challenge_method: "S256",
          state,
          prompt: "login",
          max_age: "0",
        });
        return reply.redirect(url.href);
      } catch {
        return authenticationFailure(request, reply, 503);
      }
    });

    app.get("/auth/elevate/callback", async (request, reply) => {
      const principal = await this.requireOwner(request, reply);
      if (!principal) return;
      if (!this.config.elevationOidc) {
        return authenticationFailure(request, reply, 503);
      }
      const encrypted = request.cookies[ELEVATION_OIDC_COOKIE];
      if (!encrypted) return authenticationFailure(request, reply, 400);
      let transaction: OidcTransaction;
      try {
        const { payload } = await jwtDecrypt(encrypted, this.config.sessionKey);
        transaction = {
          state: String(payload.state),
          verifier: String(payload.verifier),
          returnTo: this.safeReturnTo(String(payload.returnTo)),
          subject: String(payload.subject),
        };
      } catch {
        return authenticationFailure(request, reply, 400);
      }
      if (transaction.subject !== principal.subject) {
        return authenticationFailure(request, reply, 403);
      }
      const currentUrl = new URL(request.url, this.config.publicOrigin);
      let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
      try {
        tokens = await oidc.authorizationCodeGrant(
          await this.elevationProvider(),
          currentUrl,
          {
            pkceCodeVerifier: transaction.verifier,
            expectedState: transaction.state,
          },
        );
      } catch {
        return authenticationFailure(request, reply, 401);
      }
      let claims: ReturnType<typeof tokens.claims>;
      try {
        claims = tokens.claims();
      } catch {
        return authenticationFailure(request, reply, 401);
      }
      if (claims?.sub !== principal.subject) {
        return authenticationFailure(request, reply, 403);
      }
      const elevationGroups = Array.isArray(claims.groups)
        ? claims.groups.filter(
            (value): value is string => typeof value === "string",
          )
        : typeof claims.groups === "string"
          ? [claims.groups]
          : [];
      if (
        !this.config.oidc ||
        !elevationGroups.includes(this.config.oidc.ownerGroup)
      ) {
        return authenticationFailure(request, reply, 403);
      }
      const authTime =
        typeof claims.auth_time === "number" ? claims.auth_time : null;
      const now = Math.floor(Date.now() / 1000);
      if (authTime === null || Math.abs(now - authTime) > 300) {
        return authenticationFailure(request, reply, 403);
      }
      const elevation = await new SignJWT({ purpose: "elevation" })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(principal.subject)
        .setAudience("aialra-kimi-elevation")
        .setIssuer(this.config.publicOrigin.origin)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(this.config.sessionKey);
      reply.clearCookie(ELEVATION_OIDC_COOKIE, this.cookieOptions(0));
      reply.setCookie(ELEVATION_COOKIE, elevation, {
        ...this.cookieOptions(300),
        sameSite: "strict",
      });
      return reply.redirect(transaction.returnTo);
    });

    app.post("/auth/logout", async (request, reply) => {
      if (!this.verifyCsrf(request, reply)) return;
      reply.clearCookie(SESSION_COOKIE, this.cookieOptions(0));
      reply.clearCookie(ELEVATION_COOKIE, this.cookieOptions(0));
      reply.clearCookie(CSRF_COOKIE, {
        ...this.cookieOptions(0),
        httpOnly: false,
      });
      return reply.code(204).send();
    });
  }

  private provider(): Promise<oidc.Configuration> {
    if (!this.config.oidc)
      return Promise.reject(new Error("OIDC is not configured"));
    if (this.discovery) return this.discovery;
    const pending = Promise.resolve().then(() =>
      oidc.discovery(
        this.config.oidc!.issuer,
        this.config.oidc!.clientId,
        this.config.oidc!.clientSecret,
      ),
    );
    this.discovery = pending;
    void pending.catch(() => {
      if (this.discovery === pending) this.discovery = null;
    });
    return pending;
  }

  private elevationProvider(): Promise<oidc.Configuration> {
    if (!this.config.elevationOidc)
      return Promise.reject(new Error("Elevation OIDC is not configured"));
    if (this.elevationDiscovery) return this.elevationDiscovery;
    const pending = Promise.resolve().then(() =>
      oidc.discovery(
        this.config.elevationOidc!.issuer,
        this.config.elevationOidc!.clientId,
        this.config.elevationOidc!.clientSecret,
      ),
    );
    this.elevationDiscovery = pending;
    void pending.catch(() => {
      if (this.elevationDiscovery === pending) this.elevationDiscovery = null;
    });
    return pending;
  }

  private safeReturnTo(value: string): string {
    return safeReturnPath(value, this.config.publicOrigin);
  }

  private cookieOptions(maxAge: number) {
    return {
      path: "/",
      httpOnly: true,
      secure: this.config.nodeEnv === "production",
      sameSite: "lax" as const,
      maxAge,
    };
  }
}
