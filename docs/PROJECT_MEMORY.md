# Project Memory

Updated: 2026-07-16

## Current Milestone

Native Messaging and Workflow Sync.

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

- Pairing is contract-only.
- Controller Core refactor is not implemented in this milestone.
- Outbound persistent Agent-to-Controller sessions are not implemented in this milestone.
- Real browser/container acceptance still depends on the local environment providing Edge/Chrome automation and Docker.

## Next Milestone

Outbound Agent Session and Controller Core.

## Open Questions

- Exact Controller storage model for WorkflowRevision history.
- Exact Agent session reconnect policy and backoff limits.
- Whether Protocol v2 should later move from specialized validation to a locked JSON Schema validator dependency.
