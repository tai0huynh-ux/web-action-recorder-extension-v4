# Codex MVP Execution State

Current phase:
Phase 2 - Complete Physical LAN Reliability

Current subphase:
Stage G - Revocation physical verification passed; Phase 3 soak is next

Last green commit:
4e44ed0c289a78eb8f8f97ad82a1efb8493ab9b4

HEAD:
4e44ed0c289a78eb8f8f97ad82a1efb8493ab9b4

origin/main:
4e44ed0c289a78eb8f8f97ad82a1efb8493ab9b4

Working tree:
Revocation repair passed tests and physical verification; pending checkpoint commit.

Completed milestones:
- Phase 0 recovery completed with HEAD equal to origin/main and no tracked pilot artifacts.
- Phase 1 running cancellation and duplicate cancellation repair completed and pushed.
- Phase 2 disconnect during execution repair completed and pushed.
- Phase 2 runtime-only Controller restart, Agent restart, wrong credential, unpaired Agent, and wrong TLS endpoint cases passed.

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
Create a fresh paired identity only if required for soak, then run the Phase 3 physical LAN soak matrix.

MVP remaining work:
- Phase 3 physical LAN soak matrix.
- Managed container backend and UI.
- Origin synchronization.
- Grouped input MVP.
- Action graph MVP.
- Workspace and UX integration.
- Security, release, documentation, and final MVP acceptance.
