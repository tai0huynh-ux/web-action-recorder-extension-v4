# Codex MVP Execution State

Current phase:
Phase 4 - Managed Container Backend

Current subphase:
Phase 3 soak passed; managed container implementation is next

Last green commit:
2080461b6a9ae471d83fa37aee73d895b1af79df

HEAD:
2080461b6a9ae471d83fa37aee73d895b1af79df

origin/main:
2080461b6a9ae471d83fa37aee73d895b1af79df

Working tree:
Clean after Browser Agent replay startup repair checkpoint push.

Completed milestones:
- Phase 0 recovery completed with HEAD equal to origin/main and no tracked pilot artifacts.
- Phase 1 running cancellation and duplicate cancellation repair completed and pushed.
- Phase 2 disconnect during execution repair completed and pushed.
- Phase 2 runtime-only Controller restart, Agent restart, wrong credential, unpaired Agent, and wrong TLS endpoint cases passed.
- Phase 2 revocation repair completed, physically verified from packaged Controller UI, and pushed.
- Post-revocation fresh Agent credential created through Controller pairing and verified online for soak.
- Phase 3 physical LAN soak matrix passed after Browser Agent replay startup repair.

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

Current interrupted work:
None.

Tests last passed:
- npm.cmd run check:controller-core
- npm.cmd run test:controller-core
- npm.cmd run check:controller-electron
- npm.cmd run test:controller-electron:unit
- npm.cmd run check:controller-wss
- npm.cmd run test:controller-wss
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

Known product bugs:
- None known in completed Phase 2 and Phase 3 reliability cases.

Known infrastructure blockers:
- Normal SSH configuration may be blocked by local SSH config permissions; use a null SSH config for the physical Linux host when needed.

Next safe action:
Start Phase 4 managed container backend.

MVP remaining work:
- Managed container backend and UI.
- Origin synchronization.
- Grouped input MVP.
- Action graph MVP.
- Workspace and UX integration.
- Security, release, documentation, and final MVP acceptance.
