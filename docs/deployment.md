# Deployment

## 1 Scope

This document describes the public deployment contract without embedding production inventory, object identifiers, credentials, or operator paths

Use a separate private operations repository for host inventory, secret references, identity and edge object state, deployment receipts, and rollback records

## 2 Prerequisites

- A Linux VPS with systemd, Nginx, SQLite, and TLS certificates
- Node.js 24.15.x and pnpm 10.33.x for builds
- Rust 1.95.x for host-agent builds
- An OIDC provider supporting Authorization Code, PKCE, owner-group claims, password reauthentication, and MFA
- Optional Cloudflare proxying with WebSocket support, strict TLS, WAF, handshake limits, and cache bypass
- A release-signing or provenance mechanism whose verification happens before extraction

## 3 Build the public core

```bash
corepack enable # Select the pnpm version pinned by the repository
pnpm install --frozen-lockfile # Install the exact dependency graph
pnpm check # Run format, type, and TypeScript tests
pnpm build # Build the control plane and Web application with SRI metadata
pnpm check:rust # Run Rust formatting, Clippy, and tests
cargo build --manifest-path crates/agent/Cargo.toml --release --bins # Build agent and platform broker binaries
```

Do not promote an artifact built from a dirty tree

Record source revision, toolchain versions, upstream lock hash, artifact SHA-256, and signature or provenance with each release

## 4 Configure identity

Create two OIDC clients: one for ordinary access and one for terminal elevation

Both clients must use exact HTTPS callback URLs, owner-group authorization, password reauthentication, and MFA

Map the resulting values to `.env.example`, store client secrets in systemd credentials, and keep `DEV_AUTH_BYPASS=0`

## 5 Install the control plane

1. Create an unprivileged `aialra-kimi` service account
2. Extract the verified artifact into a new immutable release directory
3. Point `current` to that directory atomically
4. Install `deploy/systemd/aialra-kimi-control-plane.service`
5. Adapt `deploy/nginx/aialra-kimi.conf` with an example-derived public hostname and real certificate locations
6. Start the service and verify `/health/ready` over loopback before exposing it through Nginx
7. Verify anonymous API access is rejected and static assets use CSP, SRI, and `Cache-Control: no-store`

Never publish the SQLite listener, Node listener, Kimi Server, agent, or elevated broker directly to the Internet

## 6 Enroll hosts

Generate a one-time code only after an owner login, then enroll from the target host with the command shown by the Web interface

For VPS mode, run the agent and Kimi under a dedicated low-privilege user

For remote mode, run the agent as the same user that owns the Kimi configuration and session data

Install the Windows LocalSystem broker separately and only from an administrator-approved, verified artifact

Complete official Kimi OAuth login independently on every host; do not copy OAuth credential files between machines

## 7 Edge requirements

- Proxy only the intended public hostname
- Require strict origin TLS
- Allow WebSocket upgrades and disable caching on API, relay, terminal, and OAuth paths
- Rate-limit WebSocket handshakes at the edge
- Keep application frame-size, frame-rate, concurrency, sequence, and replay controls because edge limits cover only the handshake
- Do not trust externally injected identity headers

## 8 Backups and restore drills

Take SQLite online backups rather than copying a live WAL database directly

Encrypt backups to an offline recovery recipient and include runtime secrets only inside that encrypted archive; do not keep the recovery private key on the VPS

An isolated restore drill must verify ciphertext hash, archive paths, file manifest, SQLite integrity, v1 table set, database hash, and required runtime secrets without replacing production state

TLS private keys can be reissued and should not be duplicated into the application backup by default

## 9 Upgrade and rollback

Before promotion, refresh `upstream.lock.json` in a review branch and run contracts, browser flows, agent tests, and security regression checks

Deploy the same verified artifact to a new immutable directory, switch `current`, restart, and wait for readiness

On failure, restore the prior `current` target, service and Nginx configuration, database backup, and private object state, then rerun health and authorization checks

Never auto-promote a weekly upstream check to production

## 10 Acceptance gates

- Anonymous, expired, non-owner, revoked-agent, replayed-grant, and forged-identity requests are rejected
- Two hosts with the same upstream session identifier remain isolated
- Offline hosts expose sanitized metadata only
- OAuth tokens never reach the browser
- Standard terminals pass input, output, resize, exit, reconnect, and Unicode checks on each supported platform
- Elevated sessions enforce failure throttling, idle and maximum lifetime, and disconnect destruction
- Rollback restores a healthy prior release
- Public source, complete Git history, media, submodules, LFS, artifacts, and README pass the publication audit
