# Codex MVP Execution State

Current phase:
Phase 6 - Grouped Input MVP

Current subphase:
Phase 5 origin synchronization backend, protocol, renderer controls, and physical LAN acceptance passed; grouped input is next

Last green commit:
a4c7eb81ac77341abd8a9d48d9ff39463b95dc33

HEAD:
a4c7eb81ac77341abd8a9d48d9ff39463b95dc33

origin/main:
a4c7eb81ac77341abd8a9d48d9ff39463b95dc33

Working tree:
Dirty with completed Phase 5 origin synchronization implementation pending checkpoint commit.

Completed milestones:
- Phase 0 recovery completed with HEAD equal to origin/main and no tracked pilot artifacts.
- Phase 1 running cancellation and duplicate cancellation repair completed and pushed.
- Phase 2 disconnect during execution repair completed and pushed.
- Phase 2 runtime-only Controller restart, Agent restart, wrong credential, unpaired Agent, and wrong TLS endpoint cases passed.
- Phase 2 revocation repair completed, physically verified from packaged Controller UI, and pushed.
- Post-revocation fresh Agent credential created through Controller pairing and verified online for soak.
- Phase 3 physical LAN soak matrix passed after Browser Agent replay startup repair.
- Phase 4 managed container backend and Controller UI completed with SSH Docker adapter, managed Agent credential provisioning, lifecycle controls, bounded status/resource reporting, and physical LAN acceptance.
- Phase 5 origin synchronization completed with protocol request/response validation, authenticated WSS request correlation, Agent inventory/workflow response handling, Controller preview/pull/audit service, renderer controls, and physical LAN acceptance.

Completed reliability cases:
- Offline session marking.
- Offline dispatch warning visibility.
- Expired offline dispatch replay with the same job ID.
- Running cancel.
- Duplicate cancel idempotency.
- Disconnect during execution.
- Controller restart persistence runtime case.
- Agent/container restart runtime case.
- Wrong credential rejection.
- Unpaired Agent rejection.
- Wrong TLS hostname/IP rejection.
- Revocation enforcement from packaged Controller UI.
- Phase 3 soak: 20 successful workflow dispatches, 5 Agent/container restarts, 3 Controller restarts, 5 offline dispatch/replay cycles, 5 running cancellations, and 3 disconnect-during-execution cases.
- Managed container add, Agent connect, status refresh, bounded resource usage, stop, start, restart, duplicate with distinct Docker name, and delete.
- Origin synchronization preview, conflict detection, skip conflict policy, preserve-both conflict policy, new workflow import, secret-like field stripping, and audit trail.

Current interrupted work:
None. Phase 5 source is complete and awaiting checkpoint commit/push.

Tests last passed:
- npm.cmd run check:controller-core
- npm.cmd run test:controller-core
- node --check platform/protocol/src/protocolV2.js
- node --check platform/protocol/test/protocolSchemas.test.js
- npm.cmd run test:platform:protocol
- npm.cmd run check:controller-wss
- npm.cmd run test:controller-wss
- npm.cmd run check:browser-agent
- npm.cmd run test:browser-agent:unit
- npm.cmd run check:controller-electron
- npm.cmd run test:controller-electron:unit
- git diff --check

Physical acceptance last passed:
- Running cancel and duplicate cancel physical cases.
- Disconnect during execution physical case.
- Controller restart runtime case.
- Agent/container restart runtime case with fixed clipboard acceptance string: hôm nay thật vui
- Wrong credential, unpaired Agent, and wrong TLS endpoint negative cases.
- Revocation from packaged Controller UI: active Agent session closed, revoked reconnect did not become online, dispatch to revoked device was rejected with DEVICE_REVOKED, and no new job or execution event was created.
- Post-revocation re-pair: same physical Agent came online with a fresh active paired record and revoked state cleared.
- Phase 3 soak matrix PASS with evidence under ignored physical LAN runtime artifacts.
- Phase 4 managed container physical gate PASS with evidence under ignored physical LAN runtime artifacts: `managed-container-phase4-1784321109823.json`.
- Phase 5 origin synchronization physical gate PASS with evidence under ignored physical LAN runtime artifacts: `origin-sync-phase5-1784321955684.json`.

Known product bugs:
- None known in completed Phase 2 and Phase 3 reliability cases.
- None known in completed Phase 4 and Phase 5 cases.

Known infrastructure blockers:
- Normal SSH configuration may be blocked by local SSH config permissions; use a null SSH config for the physical Linux host when needed.
- Browser Agent physical Docker image can be stale after local source changes; rebuild `war-browser-agent:phase1` on `root@192.168.1.201` before physical gates that exercise new Agent code.

Next safe action:
Commit and push Phase 5 origin synchronization checkpoint, then start Phase 6 grouped input MVP.

MVP remaining work:
- Grouped input MVP.
- Action graph MVP.
- Workspace and UX integration.
- Security, release, documentation, and final MVP acceptance.
