# Project Memory

Updated: 2026-07-16

## Current Milestone

Controller-to-Extension Workflow Execution Downlink and E2E Gate: PASS.

## Confirmed Architecture Decisions

- Browser Agent is the authoritative device identity.
- Extension is a local execution component inside a Browser Agent endpoint.
- The Extension graph runner remains the main workflow execution engine.
- Browser Agent live control does not replace workflow graph execution.
- Native Messaging is implemented as a small Native Host bridge to the Browser Agent private local socket.
- Legacy Extension-to-Companion polling remains a compatibility path.

## Contracts Added

- DeviceDescriptor and DeviceCapability.
- PresenceEvent.
- WorkflowRevision and InputDefinition.
- DispatchPlan and DispatchAssignment.
- ExecutionJob and ExecutionEvent.
- AgentHello.
- AgentEnvelope, ControllerEnvelope, and NativeBridgeEnvelope.
- PairingRequest and PairingResult.
- Native bridge runtime messages: bridge health, workflow upload/list/get, execution event/result/cancel, and emergency stop.

## Compatibility Decisions

- Extension save-profile flow now attempts non-blocking workflow sync over Native Bridge.
- No Companion HTTP or scheduler runtime behavior changed.
- Browser Agent HTTP runtime behavior remains unchanged; Native Bridge uses a private local socket.
- Companion command statuses map through a pure compatibility adapter.
- Unsupported future capabilities such as remote video and clipboard are represented as false.
- `legacyCompanionPollingEnabled` defaults to true for existing compatibility.
- Companion HTTP is now a compatibility adapter over Controller Core.
- Controller Core has no HTTP, WebSocket, Electron, Chrome API, or fixed filesystem path dependency.
- Pairing/session state is owned by Controller Core; WSS is only an adapter.
- Browser Agent initiates outbound WSS when configured and does not open a public listener for controller sessions.
- Session credentials must not be placed in URLs or persisted as plaintext.
- `ws` is the runtime WebSocket implementation for authenticated outbound Controller sessions and Controller WSS runtime wrapping.
- Node/global WebSocket must not be used for authenticated opening headers.
- Persistent command state is the restart replay source of truth; `session.pendingJobs` is only a transient cache.
- Dispatch metadata and idempotency keys must persist with the command so duplicate dispatch after Controller restart returns the same command.
- Reconnect lifecycle must schedule one reconnect per active socket close path and ignore stale socket events.
- Pairing code and session credential digest comparison uses `crypto.timingSafeEqual`.
- Real Linux WSS/TLS gate is mandatory before accepting this milestone.
- Electron Controller renderer must remain plain HTML/CSS/ES modules with no renderer framework, no remote assets, no storage-based credential persistence, no generic IPC, and no direct Node/Electron APIs.
- Electron dispatch UI may create persisted jobs and report transport delivery/warning.
- Controller-to-Extension execution uses the existing Extension graph runner as the execution authority.
- Browser Agent only bridges WSS and Native Messaging for execution downlink/uplink; it does not create a second graph runner.
- Windows Native Messaging E2E uses a generated temporary executable shim, not a committed binary and not a `.cmd`/`.bat` wrapper.
- Edge Native Messaging registry lifecycle is test-scoped: install for the gate, remove during cleanup.

## Tests And Baseline

Baseline before changes:

- HEAD: `222697e57d31f5b2ee628ab9cc77970443a470dd`.
- `npm.cmd run check`: Pass.
- `npm.cmd run test:all`: Pass, 123 tests.
- Phase 2 Native X11 Gate: Complete.

Architecture contract verification:

- Protocol contract tests cover valid envelopes, unknown type, wrong protocol version, unknown top-level property, oversized values, invalid timestamp, missing deadline, missing idempotency key, Companion status mapping, and execution status enum consistency.
- Workflow adapter tests cover profile-to-revision, revision-to-profile, round-trip semantics, deterministic content hash, runtime state removal, secret plaintext removal, and input inference.
- Input parser tests cover duplicate name/index, field-to-named-input mapping, missing/extra fields, empty field validity, and sensitive value redaction from validation errors.

## Known Gaps

- Real browser/container acceptance still depends on the local environment providing Edge/Chrome automation and Docker.
- Chrome can remain blocked where local policy or automation mode rejects `--load-extension`; the accepted local E2E path is Edge MV3.
- Packaging/signing, production LAN/TLS deployment, and sensitive workflow inputs remain out of scope.

## Next Milestone

Production packaging/signing and sensitive input policy.

## Open Questions

- Exact Controller storage model for WorkflowRevision history.
- Exact Agent session reconnect policy and backoff limits.
- Whether Protocol v2 should later move from specialized validation to a locked JSON Schema validator dependency.
