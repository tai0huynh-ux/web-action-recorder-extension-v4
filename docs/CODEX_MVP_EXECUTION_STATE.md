# Codex MVP Execution State

Current phase:
Phase 3 - Physical LAN Soak and Personal-LAN Acceptance

Current subphase:
Ready to start soak matrix

Last green commit:
a634a063a671cb00639e5c442d104eddb9e910b1

HEAD:
a634a063a671cb00639e5c442d104eddb9e910b1

origin/main:
a634a063a671cb00639e5c442d104eddb9e910b1

Working tree:
Clean after revocation checkpoint push.

Completed milestones:
- Phase 0 recovery completed with HEAD equal to origin/main and no tracked pilot artifacts.
- Phase 1 running cancellation and duplicate cancellation repair completed and pushed.
- Phase 2 disconnect during execution repair completed and pushed.
- Phase 2 runtime-only Controller restart, Agent restart, wrong credential, unpaired Agent, and wrong TLS endpoint cases passed.
- Phase 2 revocation repair completed, physically verified from packaged Controller UI, and pushed.

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

Current interrupted work:
None.

Tests last passed:
- npm.cmd run check:controller-core
- npm.cmd run test:controller-core
- npm.cmd run check:controller-electron
- npm.cmd run test:controller-electron:unit
- npm.cmd run check:controller-wss
- npm.cmd run test:controller-wss

Physical acceptance last passed:
- Running cancel and duplicate cancel physical cases.
- Disconnect during execution physical case.
- Controller restart runtime case.
- Agent/container restart runtime case with fixed clipboard acceptance string: hôm nay thật vui
- Wrong credential, unpaired Agent, and wrong TLS endpoint negative cases.
- Revocation from packaged Controller UI: active Agent session closed, revoked reconnect did not become online, dispatch to revoked device was rejected with DEVICE_REVOKED, and no new job or execution event was created.

Known product bugs:
- None known in completed Phase 2 reliability cases.

Known infrastructure blockers:
- Normal SSH configuration may be blocked by local SSH config permissions; use a null SSH config for the physical Linux host when needed.

Next safe action:
Create a fresh paired identity if required after revocation, then run the Phase 3 physical LAN soak matrix.

MVP remaining work:
- Phase 3 physical LAN soak matrix.
- Managed container backend and UI.
- Origin synchronization.
- Grouped input MVP.
- Action graph MVP.
- Workspace and UX integration.
- Security, release, documentation, and final MVP acceptance.
