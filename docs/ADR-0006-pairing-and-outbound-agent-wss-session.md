# ADR-0006: Pairing Identity and Outbound Agent WSS Session

Status: Accepted

Date: 2026-07-16

## Context

Controller Core is now the reusable domain boundary for Companion HTTP and future controller surfaces. Browser Agent owns the authoritative device identity, while Native Messaging keeps Extension workflow execution local to the Agent endpoint.

The next runtime step needs pairing and persistent Agent-to-Controller sessions without opening a public Agent listener or duplicating Controller Core scheduling and workflow state.

## Decision

Pairing is implemented inside Controller Core as a bounded, auditable domain service. A pending pairing stores only a hash of the one-time code, has a TTL, is bound to the Browser Agent device descriptor, and must be explicitly confirmed or rejected. Confirmed pairing stores only a credential hash. Revoke disables the paired credential and marks the device offline; re-pair rotates the credential.

Outbound sessions are managed by Controller Core through `SessionManager`. The session manager authenticates `AgentHello` against paired credentials, owns presence, heartbeat timeout, generation-based duplicate replacement, workflow metadata reconciliation, dispatch idempotency, cancel, reconnect replay for non-terminal jobs, and stale-session rejection.

`platform/controller-wss/src/serverAdapter.js` is a transport adapter over Controller Core. It validates Protocol v2 envelopes, enforces payload bounds, maps structured errors, and does not contain scheduling, workflow registry, or state transition logic.

Browser Agent now has an outbound `ControllerSessionClient`. It only connects to `wss://` URLs, refuses credentials in URLs, sends credentials through connector headers, uses exponential backoff with jitter and min/max bounds, bounds pending requests and outbound queue, and clears socket/timer/listener state on shutdown.

Runtime verification found that Node/global `WebSocket` does not reliably support authenticated opening headers through the constructor options shape originally used. The runtime decision is to use the `ws` package for the Browser Agent outbound client and Controller WSS server wrapper. The credential remains in the opening Authorization header only; it is not placed in URL, query string, fragment, subprotocol, logs, or artifacts.

`platform/controller-wss/src/wssServer.js` is the concrete runtime wrapper. It receives an external HTTP/HTTPS server, accepts only `/v1/agent-session`, parses a single Bearer Authorization header, rejects malformed/missing/multiple credentials without exposing credential state, enforces max payload through `ws`, and delegates authenticated connections to `ControllerWssServerAdapter`.

Dispatch replay is runtime-verified against persistent state. Command records store `dispatchMetadata` with schema version, workflow id/revision/content hash, inputs, deadline, idempotency key, control path, job id, lease id, and device id derived from command state. After ControllerCore object/process restart, reconnect replay is rebuilt from persisted non-terminal commands; `session.pendingJobs` is a transient cache only.

Lease and idempotency semantics are persistent: duplicate dispatch with the same idempotency key returns the same command metadata, including `jobId`, `leaseId`, and `idempotencyKey`, instead of creating a new command after restart.

Reconnect lifecycle is guarded per active socket. A socket `error` and `close` sequence schedules one reconnect, and stale events from a replaced socket cannot move the current socket out of `online`.

Secret digest comparisons use `crypto.timingSafeEqual` through a helper that returns authentication failure for malformed or different-length digests without throwing.

## Consequences

- Controller Core remains independent from WebSocket, HTTP, Electron, Chrome APIs, and fixed filesystem paths.
- No public Agent listener is added.
- Legacy Companion HTTP remains as compatibility and diagnostics.
- No WebRTC, remote video, DataChannel, Electron, multi-view, or large UI was added.
- The project now carries one WebSocket dependency, `ws`, for authenticated headers and runtime WSS wrapping.

## Security Notes

- Pairing code and session credential plaintext are never persisted.
- Pairing and audit data are structurally redacted.
- WSS credentials are not placed in URLs.
- Protocol version and malformed envelopes are rejected before domain mutation.
- Duplicate active sessions are replaced by generation, and stale session events are rejected.

## Runtime Verification

Verified on 2026-07-16:

- Windows local `npm.cmd run check`: Pass.
- Windows local `npm.cmd run test:all`: Pass.
- Windows local `npm.cmd run test:controller-session:wss-gate`: Pass.
- Linux source path `/opt/war/web-action-recorder-extension-v4-wss-runtime-20260716104245`.
- Linux `npm run check`: Pass.
- Linux `npm run test:all`: Pass, 213 tests.
- Linux `npm run test:controller-session:wss-gate`: Pass, artifact `/opt/war/web-action-recorder-extension-v4-wss-runtime-20260716104245/artifacts/controller-wss/wss-gate-1784198588905.json`.
- Linux `npm run container:browser-agent:build`: Pass.
- Linux `npm run container:browser-agent:controller-session-gate`: Pass, artifact `/opt/war/web-action-recorder-extension-v4-wss-runtime-20260716104245/artifacts/controller-wss/wss-gate-1784198609263.json`.
- Linux `WAR_BROWSER_NO_SANDBOX=1 npm run container:browser-agent:smoke`: Pass.
- Linux `WAR_BROWSER_NO_SANDBOX=1 npm run test:browser-agent:integration`: Pass.

Known limitation: Controller dispatch is verified at transport/session/job-state level. Full workflow execution still belongs to the Extension graph runner, and this package does not add a new runner or large Protocol v2 dispatch downlink.
