# Project Memory

Updated: 2026-07-16

## Current Milestone

Architecture Consolidation Contracts.

## Confirmed Architecture Decisions

- Browser Agent is the authoritative device identity.
- Extension is a local execution component inside a Browser Agent endpoint.
- The Extension graph runner remains the main workflow execution engine.
- Browser Agent live control does not replace workflow graph execution.
- Native Messaging and pairing are contract-only in this milestone.
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

## Compatibility Decisions

- No Extension runtime behavior changed.
- No Companion HTTP or scheduler runtime behavior changed.
- No Browser Agent HTTP runtime behavior changed.
- Companion command statuses map through a pure compatibility adapter.
- Unsupported future capabilities such as remote video and clipboard are represented as false.

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

- Protocol v2 is contract and adapter code only; no transport is implemented.
- Pairing is contract-only.
- NativeBridgeEnvelope is contract-only.
- Controller Core refactor is not implemented in this milestone.
- Outbound persistent Agent-to-Controller sessions are not implemented in this milestone.

## Next Milestone

Controller Core and persistent Agent session architecture, after approval.

## Open Questions

- Exact Controller storage model for WorkflowRevision history.
- Exact Agent session reconnect policy and backoff limits.
- Whether Protocol v2 should later move from specialized validation to a locked JSON Schema validator dependency.
