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

## Managed container network settings

- IPv4 and IPv6 can be enabled independently per managed container; at least one family is required.
- IPv6 uses the host's discovered global `/64` prefix plus a persisted user-selected final 64-bit suffix. On an on-link prefix, the suffix must be EUI-64 (`xxxx:xxff:fexx:xxxx`) so the derived MAC and SLAAC identity remain stable; routed/delegated prefixes use the IPv6 bridge driver.
- Start, Restart, and Apply network reconcile a changed provider prefix while preserving the suffix; Refresh reports drift without silently mutating a running container.
- The implementation keeps the reviewed non-root/AppArmor/seccomp/no-host-network policy. Public inbound IPv6 on a routed/delegated prefix still requires upstream routing or intentional NDP proxying.
- This enhancement is covered by Controller Core/Electron unit tests, full local regression, release packaging, and disposable remote Docker macvlan/IPv6-network probes. A new physical Phase 10 product run is required before making a new-SHA MVP readiness claim.

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

Implementation checkpoint `6e0be390758851d94921450a7ded3d17fc85bdf1` is the current exact source SHA. The reviewed Linux host passed the persistent AppArmor/seccomp verification, disposable policy probe, and the managed lifecycle acceptance on that SHA using the rebuilt image `war-browser-agent:phase10-6e0be39`. The latest managed evidence (`phase10-managed-acceptance-1784833772124.json`) proves Add, status, Stop, Start, Restart, Duplicate, Delete, authenticated WSS online state, exact SSH identity/options, bounded resources, loopback-only control port, active Chromium sandbox, and cleanup.

The complete managed product and soak evidence already recorded for `6e0be390` covers startup/reconciliation, origin synchronization with repeated-pull idempotency, graph revision preservation/execution, grouped text/table/cell input, exact clipboard verification, cancellation and duplicate cancellation, offline same-job replay exactly once, Agent/Controller restart persistence, negative credential/TLS/pairing cases, revocation, and the required soak matrix with zero duplicate or unsandboxed cycles. Local WSS (`wss-gate-1784833851028.json`), Edge MV3 Controller-to-Extension E2E (`controller-extension-e2e-1784833893846.json`), full regression (226 tests), and release gate (`release-gate-1784833714174.json`) all pass on this SHA.

Runtime evidence under `artifacts/physical-lan-pilot/` is intentionally ignored and must not be committed. The final readiness claim is still bound to CI, Container Real World Gate, and Windows Release Gate passing on the exact final documentation commit.

## Classification

- `PASS`: every required exact-SHA gate and soak case passes.
- `BUGS_FOUND`: product or test defects remain reproducible.
- `BLOCKED_INFRASTRUCTURE`: no secure capable host or required external infrastructure is available.
- `BLOCKED_MANUAL_ACTION`: a runner token, signing material, physical host, or other user-owned action is required.
