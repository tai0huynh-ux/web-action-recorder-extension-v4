# MVP Acceptance

## Decision rule

`MVP_READY_FOR_PERSONAL_LAN_USE` requires all items below on the exact final SHA. A local unit-test pass or browser startup alone is insufficient.

## Phase 9 release gate

- `npm.cmd ci`, `npm.cmd run check`, and `npm.cmd run test:all` pass.
- WSS gate, Controller-to-Extension Edge E2E, Electron smoke, packaged smoke, release integrity, and release gate pass.
- GitHub CI, Container Real World Gate, and Windows Release Gate pass on the exact SHA.
- Container probe reports `USERNS_SANDBOX_CAPABLE`.
- Chromium reports `suid=false`, `userNs=true`, `pidNs=true`, `netNs=true`, `seccompBpf=true`, and `sandboxGood=true` from `chrome://sandbox`.
- Container security assertions prove non-root, non-privileged, bridge/private PID namespaces, no Docker socket/host home/capability additions, bounded resources, exact AppArmor, and canonical seccomp match.
- Security Critical = 0 and High = 0; accepted medium/low limitations are documented.
- No installed dependencies, generated packages, pilot artifacts, browser profiles, runtime state, credentials, or secrets are tracked.

## Phase 10 product path

The packaged Controller must complete the supported path: startup, TLS WSS, managed container, active sandbox, pairing/authentication, Chromium, MV3, Native Messaging, controlled record/run, origin inventory/preview/pull/idempotent pull, graph edit/validation/new revision, grouped text/table/cell input, dispatch/ack/start/success, clipboard, cancel/duplicate cancel, offline replay/exactly-once, Controller restart, Agent restart, negative credential/TLS/pairing cases, revocation, package integrity, and cleanup.

## Soak

- 20 successful dispatches.
- 5 Agent/container restarts.
- 3 Controller restarts.
- 5 offline replay cycles.
- 5 running cancellations.
- 3 disconnect-during-execution cases.
- 3 origin synchronization cycles.
- 3 grouped-input cycles covering text, table, and cell modes.
- 3 graph revision save-and-execute cycles.

Required zero counts: duplicate executions, lost terminal results, credential exposures, duplicate devices, duplicate authoritative sessions, synchronization duplicates, unexpected revision overwrites, and unsandboxed Chromium executions.

## Phase 10 execution result

The reviewed Linux host and implementation checkpoint `8fe2706c8803f04cedfc092babbe7b004b8f3f79` pass the persistent AppArmor/seccomp verification, disposable policy probe, managed lifecycle, complete product path, negative security cases, cleanup, local regression, packaging, and required soak matrix. The managed product run covers origin synchronization, repeated-pull idempotency, graph revision preservation/execution, grouped text/table/cell dispatch, exact clipboard verification, cancellation, offline exactly-once replay, and Controller/Agent restart persistence.

The final readiness claim remains bound to one additional condition: CI, Container Real World Gate, and Windows Release Gate must all pass on the exact commit containing this acceptance documentation. Runtime evidence under `artifacts/physical-lan-pilot/` is intentionally ignored and must not be committed.

## Classification

- `PASS`: every required exact-SHA gate and soak case passes.
- `BUGS_FOUND`: product or test defects remain reproducible.
- `BLOCKED_INFRASTRUCTURE`: no secure capable host or required external infrastructure is available.
- `BLOCKED_MANUAL_ACTION`: a runner token, signing material, physical host, or other user-owned action is required.
