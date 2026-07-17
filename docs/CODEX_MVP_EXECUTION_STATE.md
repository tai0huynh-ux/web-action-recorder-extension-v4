# Codex MVP Execution State

Current phase:
Phase 8 - Workspace and UX Integration

Current subphase:
Phase 7 action graph backend and saved-revision E2E acceptance passed; workspace and UX integration is next

Last green commit:
2e134b70e9436d6d031bc35e9f77173a92f69093

HEAD:
2e134b70e9436d6d031bc35e9f77173a92f69093

origin/main:
2e134b70e9436d6d031bc35e9f77173a92f69093

Working tree:
Dirty with completed Phase 7 action graph backend implementation pending checkpoint commit.

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
- Phase 6 grouped input completed with text/table/cell modes, deterministic parser mapping, preview, dispatch integration, IPC/preload contract, renderer controls, bounded limits, and real Controller-to-Extension E2E acceptance.
- Phase 7 action graph backend completed with real workflow graph load, operation preview, validated save-as-new-revision, previous revision preservation, execution plan preview, IPC/preload contract, and real Controller-to-Extension E2E execution of the saved revision.

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
- Grouped input preview and dispatch through real Controller Application, WSS, Browser Agent native bridge, MV3 Extension, and persisted job terminal result.
- Action graph edit, new revision save, and saved revision dispatch through real Controller Application, WSS, Browser Agent native bridge, MV3 Extension, and persisted job terminal result.

Current interrupted work:
None. Phase 7 source is complete and awaiting checkpoint commit/push.

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
- npm.cmd run test:platform:input-parser
- npm.cmd run check:controller-wss
- npm.cmd run test:controller-extension:e2e
- node --test test/graph-template.test.js
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
- Phase 6 grouped input Controller-to-Extension E2E PASS with evidence under ignored runtime artifacts: `artifacts/controller-extension-e2e/controller-extension-e2e-1784322456315.json`.
- Phase 7 action graph saved revision Controller-to-Extension E2E PASS with evidence under ignored runtime artifacts: `artifacts/controller-extension-e2e/controller-extension-e2e-1784322658533.json`.

Known product bugs:
- None known in completed Phase 2 and Phase 3 reliability cases.
- None known in completed Phase 4 and Phase 5 cases.
- None known in completed Phase 6 grouped input cases.
- None known in completed Phase 7 action graph backend cases.

Known infrastructure blockers:
- Normal SSH configuration may be blocked by local SSH config permissions; use a null SSH config for the physical Linux host when needed.
- Browser Agent physical Docker image can be stale after local source changes; rebuild `war-browser-agent:phase1` on `root@192.168.1.201` before physical gates that exercise new Agent code.

Next safe action:
Commit and push Phase 7 action graph backend checkpoint, then start Phase 8 workspace and UX integration.

MVP remaining work:
- Workspace and UX integration.
- Security, release, documentation, and final MVP acceptance.
