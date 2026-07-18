# Codex MVP Execution State

Current phase:
Phase 8 - Workspace and UX Integration

Current subphase:
Phase 8 acceptance revalidation. Workspace UX, packaged GUI, and local regression are green, but the corrected Windows entrypoint exposed that the local container real-world command had previously exited without running. The current commit still needs a real Docker-backed GitHub gate.

Starting baseline for Phase 8:
0d78b10271378fc4b73bc69033d2a8bfd15d11ad

Last pushed green commit before the production check coverage checkpoint:
db24da69cfc42417a94266d6d0bb653f7fbcb464

Latest green checkpoint:
Phase 8 production check coverage and Windows real-world gate harness hardening. `platform/protocol/src/protocolV2.js` is included directly in `check:platform`, and the real-world container entrypoint now uses `pathToFileURL` so Windows cannot report a silent runtime-only pass.

Completed Phase 8 subphases:
- Phase 8A architecture review completed with one read-only subagent.
- Phase 8B managed container renderer integration completed for add, start, stop, restart, duplicate, delete, status, resource usage, duplicate-action prevention, delete confirmation, sanitized errors, and authenticated-Agent-online distinction.
- Phase 8C origin synchronization renderer integration completed for authenticated origin filtering, inventory/preview loading, conflict policy display, pull gating, duplicate pull prevention, safe imported/skipped/conflicted/error counts, repeated pull skipped reporting, stale-error clearing, and sensitive-data exclusion from normal UI.
- Phase 8D grouped input renderer integration completed for stateful text/table/cell mode selection, backend-normalized preview, device mapping, broadcast policy, dispatch gating, duplicate dispatch prevention, validation error display, stale-error clearing, Vietnamese UTF-8 preservation, and sanitized dispatch result display.
- Phase 8E action graph renderer integration completed for real workflow graph load, node update operation queueing, edge operation controls, authoritative preview, validation display, unsafe operation rejection before persistence, unsaved-change discard confirmation, save-as-new-revision, previous revision preservation, refreshed revision list, and new revision selection.
- Phase 8F/8G/8H automated review completed for locale key parity, representative Vietnamese/English labels, textarea label association, safe workspace preference persistence, locale switching without state reset, and renderer interaction safety regressions.
- Packaged Controller release gate repaired by including controller runtime dependencies in the staged app and electron-builder package.

Phase 8 subphases remaining:
- Run the current commit through the Docker-backed GitHub container real-world gate and record the result.

Tests passed for the latest checkpoint:
- npm.cmd run check:browser-agent
- npm.cmd run test:browser-agent:unit
- node --check platform/protocol/src/protocolV2.js
- npm.cmd run test:platform:protocol
- npm.cmd run check:platform
- npm.cmd run test:controller-electron:packaged
- node --test platform\controller-electron\test\rendererDom.test.js
- npm.cmd run check:controller-electron
- npm.cmd run test:controller-electron:unit
- npm.cmd run test:platform:input-parser
- node --test test\graph-template.test.js
- npm.cmd run test:platform:workflow-core
- npm.cmd run test:platform:protocol
- npm.cmd run release:bundle
- npm.cmd run test:release:integrity
- npm.cmd run test:controller-electron:packaged
- npm.cmd run test:release:gate
- npm.cmd run check
- npm.cmd run test:all
- npm.cmd run test:controller-session:wss-gate
- npm.cmd run test:controller-extension:e2e
- npm.cmd run test:controller-electron:smoke
- npm.cmd run test:container-real-world
- npm.cmd audit
- npm.cmd ls --depth=0
- git diff --check

Test count:
- Controller Electron unit: 129 passing tests.
- Renderer DOM targeted: 45 passing tests.
- Input parser: 23 passing tests.
- Graph template: 7 passing tests.
- Workflow core: 10 passing tests.
- Protocol: 17 passing tests.

Packaged GUI cases passed in Phase 8:
- Packaged process and war-controller://app/ protocol.
- Packaged window security.
- Packaged preload and Vietnamese renderer navigation labels.
- Packaged seven-view navigation.
- Packaged state persistence restart-safe location.
- Packaged WSS status.
- Release gate packaged controller check.

Full Phase 8 regression:
- Local non-Docker regression: PASS.
- Local `test:container-real-world`: correctly attempted execution and reported `spawn docker ENOENT`; it is no longer a false PASS.
- Docker-backed GitHub container real-world gate for the current commit: pending.
- npm audit reported 0 vulnerabilities.
- npm ls --depth=0 completed successfully.

Artifact hygiene:
- Physical LAN pilot runtime artifacts remain ignored and must stay untracked.
- Generated packages, screenshots, logs, and QA runtime state must not be committed.

Repository hygiene issue deferred to Phase 9:
- node_modules/** is tracked in the repository. Do not clean or untrack it during Phase 8.

Known product bugs:
- No known managed-container renderer bug after the Phase 8B automated checkpoint.
- No known origin synchronization renderer bug after the Phase 8C automated checkpoint.
- No known grouped input renderer bug after the Phase 8D automated checkpoint.
- No known action graph renderer bug after the Phase 8E automated checkpoint.
- No known localization/accessibility/state consistency bug after the Phase 8F/8G/8H automated checkpoint.
- None known after full Phase 8 regression.

Known infrastructure blockers:
- Docker CLI is unavailable on the local Windows host, so the real-world container gate must be accepted on the GitHub Docker runner.
- Normal SSH configuration may be blocked by local SSH config permissions; use a null SSH config for the physical Linux host when needed.
- Browser Agent physical Docker image can be stale after local source changes; rebuild the image before physical gates that exercise new Agent code.

Next exact action:
Push the Windows entrypoint fix, run the Docker-backed GitHub container real-world gate for that exact commit, then mark Phase 8 complete only if it passes.

MVP remaining work:
- Phase 8 Docker-backed final acceptance revalidation.
- Phase 9 security, release, repository hygiene, and documentation.
- Phase 10 final MVP acceptance.
