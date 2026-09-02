# Threat model

## 1 Security objective

An authenticated single owner can control only enrolled hosts and scoped operations while Kimi content, terminal data, credentials, and file bodies remain unreadable to the relay

## 2 Protected assets

- Kimi OAuth credentials and account usage
- Host identity private keys
- Session prompts, answers, tools, tasks, approvals, and questions
- Workspace files, paths, terminal input and output, and system passwords
- Control-plane session and grant-signing keys
- Release integrity and rollback state

## 3 Trust boundaries

| Boundary        | Trusted for                                                       | Not trusted for                           |
| --------------- | ----------------------------------------------------------------- | ----------------------------------------- |
| Browser         | Owner interaction and plaintext before encryption                 | Long-term credential storage              |
| Edge and Nginx  | TLS routing, handshake filtering, and availability                | User identity or content confidentiality  |
| Control plane   | OIDC session, authorization, routing, and encrypted metadata      | Kimi or terminal plaintext                |
| Host agent      | Host identity, Kimi access, PTY lifecycle, and plaintext endpoint | Arbitrary network proxying                |
| Kimi Server     | Official session and account state                                | Exposure beyond host loopback             |
| Elevated broker | Local privileged terminal creation                                | General agent or network service behavior |

## 4 Threats and controls

| Threat                         | Primary controls                                                           | Residual risk                                            |
| ------------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------- |
| Anonymous or non-owner access  | OIDC Code + PKCE, owner-group policy, IdP MFA when configured, CSRF checks | Identity-provider compromise                             |
| Stolen or replayed grant       | Short expiry, host and scope binding, nonce store, sequence checks         | Compromised endpoint before expiry                       |
| Forged host                    | Ed25519 challenge, local protected key, revocation                         | Full compromise of the enrolled OS account               |
| Relay reads content            | Ephemeral X25519 and XChaCha20-Poly1305 frames                             | Malicious frontend can read plaintext before encryption  |
| Cross-host confusion           | `hostId` in every session reference and grant                              | Implementation defects require contract regression tests |
| SSRF or local pivot            | Allowlisted Kimi operations, loopback Kimi port, no generic HTTP proxy     | Vulnerability in an allowed upstream method              |
| Terminal password leakage      | Encrypted input, no persistence or logging, browser-storage ban            | Browser or host compromise at input time                 |
| Privileged process survives    | Idle timeout, maximum lifetime, disconnect kill, separate broker           | Operating-system failure or broker compromise            |
| XSS and supply-chain injection | CSP, no third-party scripts, SRI, immutable signed artifacts               | Compromised build or signing authority                   |
| Archive traversal              | Path validation before extraction and immutable release target             | Vulnerability in extraction tooling                      |
| Sensitive logs                 | Category-only audit schema and secret-pattern checks                       | New logging code bypasses the schema                     |

## 5 Elevation boundary

Ordinary access never implies terminal elevation

Elevation requires a separate short-lived OIDC flow with password reauthentication and a recent-authentication check; any MFA step is enforced by the identity provider's policy

Linux starts `sudo -k -i` on the target host; Windows delegates terminal creation to a separately installed LocalSystem broker over a local authenticated channel

The target host validates credentials and rate-limits failures; the control plane never receives a plaintext password

## 6 Out of scope

- Protecting data after the browser or enrolled host OS is fully compromised
- Multi-tenant isolation in v1
- Full remote desktop and GUI streaming
- Security of unsupported Kimi versions or unofficial provider endpoints
- Backing up unrelated host workspaces or Kimi message bodies to the control plane

## 7 Release security gates

Release candidates must test identity bypass, XSS, CSRF, WebSocket hijacking, replay, path traversal, SSRF, host impersonation, password leakage, and supply-chain integrity

Any unresolved secret, real screenshot, incompatible upstream protocol, unsigned artifact, failed rollback, or incomplete elevation teardown blocks publication
