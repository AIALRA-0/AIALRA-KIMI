# Architecture

## 1 Components

| Component       | Responsibility                                                                            | Explicit non-responsibility                                                |
| --------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Web client      | Host selection, Kimi session UX, approvals, usage, and encrypted terminal interaction     | Does not receive Kimi OAuth tokens                                         |
| Control plane   | OIDC sessions, host inventory, short-lived grants, offline metadata, and ciphertext relay | Does not terminate content encryption or proxy arbitrary localhost traffic |
| Host agent      | Kimi supervision, allowlisted RPC, event recovery, PTY lifecycle, and host identity       | Does not open a public inbound port                                        |
| Kimi Server     | Authoritative sessions, messages, tools, files, login state, and usage                    | Is not mirrored into the control-plane database                            |
| Elevated broker | Time-limited privileged terminal creation on Windows                                      | Does not run the main agent or accept network connections                  |

## 2 Identity and channels

1. The owner authenticates through OIDC Authorization Code with PKCE
2. A ten-minute, single-use code enrolls a host
3. The agent generates an Ed25519 identity and stores its private material locally
4. The browser requests a short-lived grant bound to owner, host, scopes, expiry, and nonce
5. Browser and agent exchange ephemeral X25519 keys through the relay
6. Both ends derive the channel key and exchange XChaCha20-Poly1305 frames
7. The relay checks routing, frame limits, and connection state without seeing plaintext

## 3 Session model

`HostSessionRef` is the pair `{ hostId, upstreamSessionId }`

The host identifier is always part of cache, routing, and UI keys, so identical upstream session identifiers on two machines do not collide

Each event carries a sequence number; reconnection combines a fresh snapshot with events after the last accepted sequence and discards duplicates

The target host remains authoritative for messages, tasks, approvals, questions, permission mode, file content, terminal state, and account usage

## 4 Offline behavior

The control plane may retain encrypted session title, timestamp, state, and sanitized workspace alias

When an agent is offline, the Web client can display only that metadata; Kimi content, files, usage, and terminal actions remain unavailable

## 5 Compatibility

`upstream.lock.json` pins Kimi Code release assets and protocol hashes

The agent probes Kimi version and capabilities before exposing control; a mismatched release becomes `unsupported`

All upstream changes pass through an adapter and contract tests before manual promotion

## 6 Failure behavior

| Failure                  | Expected behavior                                                                 |
| ------------------------ | --------------------------------------------------------------------------------- |
| Browser reconnect        | Request a new grant and channel, then resume from snapshot and sequence           |
| Agent reconnect          | Reauthenticate host identity, report capabilities, and mark stale channels closed |
| Kimi restart             | Supervise the process, reprobe protocol, and rebuild session state                |
| Control-plane restart    | Keep host data on the host; agents reconnect with bounded backoff                 |
| Unsupported Kimi version | Show `unsupported` and block control operations                                   |
| Host revocation          | Reject identity authentication and require explicit re-enrollment                 |
