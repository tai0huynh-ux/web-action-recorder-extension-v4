# ADR-0004: Native Messaging and Workflow Sync

Status: Accepted

Date: 2026-07-16

## Context

The Extension already records and runs workflows through the MV3 graph runner. The Browser Agent owns device identity and typed Chromium control. The next milestone needs a local control bridge without opening a new public listener or creating a second workflow runner.

## Decision

Chrome Native Messaging connects the Extension to a small Native Host process. The Native Host only translates Chrome stdio frames to the Browser Agent private local socket and returns framed responses to stdout.

The Browser Agent remains the authoritative device identity. The Extension does not enroll as a new device. The Extension graph runner remains the workflow execution engine for recorded workflows.

The Browser Agent exposes a private local socket at `WAR_AGENT_SOCKET_PATH`. On Linux this is a Unix domain socket under the Agent data runtime directory by default. The socket parent is created with restrictive permissions, stale sockets are cleaned only when they are real sockets, symlinks are rejected, payload size is bounded, and no public TCP fallback is introduced.

Native Messaging uses Protocol v2 envelopes and the existing NativeBridgeEnvelope validator. The milestone extends allowed message types for bridge health, workflow upload/list/get, execution events/results, cancel, and emergency stop. It does not create a parallel protocol.

Workflow revisions are persisted by the Browser Agent in a JSON registry. Duplicate `workflowId` plus `contentHash` returns the existing revision instead of creating a duplicate. Changed content increments revision deterministically per workflow.

Legacy Companion polling remains available behind `legacyCompanionPollingEnabled`. Existing installations keep it enabled by default. Native Bridge and legacy jobs share job/idempotency identifiers; first accepted execution wins in future dispatch integration.

## Security Model

- Native Host has no shell execution, filesystem browsing, generic CDP, arbitrary JavaScript, or Chromium control surface.
- Native Host stdout is reserved for Chrome Native Messaging frames only.
- Native Host stderr is structured logging only and must not include tokens or sensitive input.
- Native Messaging is not used for screenshots, video, audio, or large files.
- Browser Agent local socket has bounded payload, connection, idle, and request limits.
- Sensitive workflow step text is redacted before sync.

## Job Lifecycle

Agent-to-Extension dispatch uses `execution.dispatch` with `jobId`, workflow identity, revision, content hash, named inputs, deadline, idempotency key, and `controlPath = native_bridge`.

Extension execution validates workflow identity and emits acknowledgement, start, terminal result, and cancellation events over the bridge. Cancel and emergency stop are idempotent and must target the active job.

## Restart Behavior

Extension bridge requests are correlated by `correlationId`. Pending requests are cleared on disconnect or timeout. Workflow sync metadata is persisted in Extension storage so Agent-offline saves become pending instead of blocking local profile persistence.

## Rejected Alternatives

- Running the full Browser Agent as the Chrome Native Host: rejected because Chrome should spawn only a small stdio process.
- Public TCP listener for Native Bridge: rejected because the bridge is local-only and private.
- A second Browser Agent workflow runner: rejected because the Extension graph runner is already the canonical recorded workflow engine.
- Reusing Chrome Native Messaging binary framing on the Agent socket: rejected to keep Chrome framing isolated from the Agent local transport.
