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

## Consequences

- Controller Core remains independent from WebSocket, HTTP, Electron, Chrome APIs, and fixed filesystem paths.
- No public Agent listener is added.
- Legacy Companion HTTP remains as compatibility and diagnostics.
- No WebRTC, remote video, DataChannel, Electron, multi-view, or large UI was added.
- Node 24 provides the runtime WebSocket client used by the Browser Agent, so no new WebSocket dependency is required.

## Security Notes

- Pairing code and session credential plaintext are never persisted.
- Pairing and audit data are structurally redacted.
- WSS credentials are not placed in URLs.
- Protocol version and malformed envelopes are rejected before domain mutation.
- Duplicate active sessions are replaced by generation, and stale session events are rejected.
