# Codex MVP Execution State

Current phase:
Phase 9 - Security, CI, Repository Hygiene, Release, and Documentation

Current subphase:
Phase 9D security review is in progress; managed-container deletion revocation is repaired locally.

Last green commit:
110cdf31d8c32fdbf8600212821eb4ec66626fef

HEAD:
110cdf31d8c32fdbf8600212821eb4ec66626fef with the intended managed-container deletion revocation repair uncommitted.

origin/main:
110cdf31d8c32fdbf8600212821eb4ec66626fef

Working tree:
Modified only for the focused managed-container deletion revocation repair, regression tests, and this execution-state update.

Phase 8 result:
PHASE_8_COMPLETE.

Phase 9 completed checkpoints:
- Phase 9A complete: official Node 24 action releases pinned by immutable SHA, checkout credentials disabled, hidden artifact files excluded, policy regression coverage added, and all three GitHub workflows passed without Node.js 20 action warnings.
- Phase 9B complete: `node_modules` is ignored and removed from the Git index while the lockfile-restored local installation remains operational; commit `1e0deac17a6885011548a04eee791814c21e560d` is pushed and synchronized.
- Phase 9C complete: tracked-path classification and repository hygiene enforcement cover installed dependencies, pilot artifacts, generated packages, browser profiles, runtime state, and private credential material. `build/icon.svg` is classified as `RELEASE_INPUT`; `profiles/sample-profile.json` is classified as a synthetic `TEST_FIXTURE`.

Node 24 Actions migration:
PASS. CI `29632990127`, Container Real World Gate `29632995134`, and Windows Release Gate `29632996254` passed on `fd0a7b994054db72529bb6cb7c12702e79137494`; exact Node.js 20 action warning count is zero.

node_modules tracking:
Zero files under `node_modules/**` remain in the Git index. The local dependency tree was recreated with `npm.cmd ci` and remains ignored.

Security review:
In progress. Managed-container session credentials no longer appear in process argv after checkpoint `110cdf31d8c32fdbf8600212821eb4ec66626fef`. Main-agent review also confirmed that deletion left pairing credentials active and suppressed Docker cleanup failures; the local repair revokes the device, closes its authoritative session, propagates cleanup failure, and refuses to report registry deletion when runtime cleanup fails.

Release gate:
Phase 9B local release integrity, packaged Controller, and release gate pass after lockfile reinstall. Phase 9 final release checkpoint remains pending.

Final acceptance:
Phase 10 has not started.

Known blockers:
- None.

Next exact action:
Validate, commit, and push the managed-container deletion revocation repair, then continue independent verification of the remaining Phase 9D findings.

Remaining MVP work:
- Phase 9C through Phase 9F.
- Phase 10 clean packaged-product acceptance, soak, final regression, workflows, documentation, and cleanup.

Starting baseline for Phase 8:
0d78b10271378fc4b73bc69033d2a8bfd15d11ad

Last pushed green implementation commit before this final state update:
43cf3d70fb8ccddae3c50120b26e1e7827f59539

Latest green checkpoint:
Phase 8 final acceptance revalidation. Production syntax coverage includes `protocolV2.js`, Windows cannot silently skip the real-world gate, and GitHub Actions ran the Docker-backed gate successfully for the exact implementation commit.

Completed Phase 8 subphases:
- Phase 8A architecture review completed with one read-only subagent.
- Phase 8B managed container renderer integration completed for add, start, stop, restart, duplicate, delete, status, resource usage, duplicate-action prevention, delete confirmation, sanitized errors, and authenticated-Agent-online distinction.
- Phase 8C origin synchronization renderer integration completed for authenticated origin filtering, inventory/preview loading, conflict policy display, pull gating, duplicate pull prevention, safe imported/skipped/conflicted/error counts, repeated pull skipped reporting, stale-error clearing, and sensitive-data exclusion from normal UI.
- Phase 8D grouped input renderer integration completed for stateful text/table/cell mode selection, backend-normalized preview, device mapping, broadcast policy, dispatch gating, duplicate dispatch prevention, validation error display, stale-error clearing, Vietnamese UTF-8 preservation, and sanitized dispatch result display.
- Phase 8E action graph renderer integration completed for real workflow graph load, node update operation queueing, edge operation controls, authoritative preview, validation display, unsafe operation rejection before persistence, unsaved-change discard confirmation, save-as-new-revision, previous revision preservation, refreshed revision list, and new revision selection.
- Phase 8F/8G/8H automated review completed for locale key parity, representative Vietnamese/English labels, textarea label association, safe workspace preference persistence, locale switching without state reset, and renderer interaction safety regressions.
- Packaged Controller release gate repaired by including controller runtime dependencies in the staged app and electron-builder package.

Phase 8 subphases remaining:
- None.

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
- PASS.
- Local `test:container-real-world` correctly reports `spawn docker ENOENT` because Docker CLI is unavailable; it no longer produces a false PASS.
- GitHub Actions CI run `29632172553`: PASS for commit `43cf3d70fb8ccddae3c50120b26e1e7827f59539`.
- GitHub Actions container real-world run `29632183880`: PASS for the same commit; sanitized artifact `8425860460` uploaded.
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
- Docker CLI is unavailable on the local Windows host; the accepted Docker-backed evidence is the successful GitHub gate above.
- Normal SSH configuration may be blocked by local SSH config permissions; use a null SSH config for the physical Linux host when needed.
- Browser Agent physical Docker image can be stale after local source changes; rebuild the image before physical gates that exercise new Agent code.

Next exact action:
Begin Phase 9 - Security, release, repository hygiene, and documentation. Keep `node_modules/**` repository hygiene scoped to Phase 9.

MVP remaining work:
- Phase 9 security, release, repository hygiene, and documentation.
- Phase 10 final MVP acceptance.
