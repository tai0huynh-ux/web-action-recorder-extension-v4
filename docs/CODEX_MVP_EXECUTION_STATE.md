# Codex MVP Execution State

Current phase:
Phase 5 - Origin Synchronization

Current subphase:
Phase 4 managed container backend and UI passed; origin synchronization is next

Last green commit:
d6074034c04847493d17dfcf6fa546798fca4c56

HEAD:
d6074034c04847493d17dfcf6fa546798fca4c56

origin/main:
d6074034c04847493d17dfcf6fa546798fca4c56

Working tree:
Dirty with completed Phase 4 managed container implementation pending checkpoint commit.

Completed milestones:
- Phase 0 recovery completed with HEAD equal to origin/main and no tracked pilot artifacts.
- Phase 1 running cancellation and duplicate cancellation repair completed and pushed.
- Phase 2 disconnect during execution repair completed and pushed.
- Phase 2 runtime-only Controller restart, Agent restart, wrong credential, unpaired Agent, and wrong TLS endpoint cases passed.
- Phase 2 revocation repair completed, physically verified from packaged Controller UI, and pushed.
- Post-revocation fresh Agent credential created through Controller pairing and verified online for soak.
- Phase 3 physical LAN soak matrix passed after Browser Agent replay startup repair.
- Phase 4 managed container backend and Controller UI completed with SSH Docker adapter, managed Agent credential provisioning, lifecycle controls, bounded status/resource reporting, and physical LAN acceptance.

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

Current interrupted work:
None.

Tests last passed:
- npm.cmd run check:controller-core
- npm.cmd run test:controller-core
- npm.cmd run check:controller-electron
- npm.cmd run test:controller-electron:unit
- npm.cmd run check:browser-agent
- npm.cmd run test:browser-agent:unit

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

Known product bugs:
- None known in completed Phase 2 and Phase 3 reliability cases.

Known infrastructure blockers:
- Normal SSH configuration may be blocked by local SSH config permissions; use a null SSH config for the physical Linux host when needed.

Next safe action:
Commit and push Phase 4 managed container checkpoint, then start Phase 5 origin synchronization.

MVP remaining work:
- Origin synchronization.
- Grouped input MVP.
- Action graph MVP.
- Workspace and UX integration.
- Security, release, documentation, and final MVP acceptance.
