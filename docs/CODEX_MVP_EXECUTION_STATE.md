# Codex MVP Execution State

Current phase:
Phase 9 - Security, CI, Repository Hygiene, Release, and Documentation

Current subphase:
Phase 9D managed-container Docker verification; exact-head run `29653358667` proved the active Chromium sandbox and full product path, leaving only Docker inspect's inline seccomp JSON representation to verify without persisting it.

Last green commit:
8e5adceadfef204f643293d7204b27bb7834e196

HEAD:
74a88713c5f9e22e1595e907b385ecb75a419d41 plus canonical measured-seccomp verification pending commit.

origin/main:
74a88713c5f9e22e1595e907b385ecb75a419d41

Working tree:
Modified only to verify Docker's measured inline seccomp policy by canonical hash, keep artifact evidence category-only, add managed-runtime regression coverage, and update this execution state.

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
Final read-only review found additional blockers. CDP modifier release is fixed in `dde835d`. The current repair streams the Agent credential into an Agent-only `0600` file, removes credential-like variables from Chromium children, rejects renderer-selected images, resolves and verifies the approved image ID, explicitly runs as `war`, removes forced no-sandbox defaults, and rejects Docker inspect state that violates the managed runtime policy.

Release gate:
Current local release bundle contains 79 integrity-checked artifacts; tamper detection, package secret scan, packaged Controller smoke, Electron GUI smoke, and release gate pass. Phase 9 final exact-HEAD release checkpoint remains pending.

Final acceptance:
Phase 10 has not started.

Known blockers:
- GitHub Container Real World Gate `29653358667` at `74a8871` classified the host `USERNS_SANDBOX_CAPABLE`; Chromium authoritatively reported SUID false and user/PID/network/seccomp-BPF/TSYNC plus overall sandbox true. The full product path passed. The sole failed assertion was path-based seccomp comparison because Docker inspect returns the loaded policy JSON, not its source path.

Next exact action:
Commit and push canonical measured-seccomp verification, rerun the exact-head gate, and require every sandbox, runtime, product, and cleanup assertion to pass with sanitized evidence only.

Remaining MVP work:
- Phase 9D through Phase 9F.
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
