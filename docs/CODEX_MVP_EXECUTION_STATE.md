# Codex MVP Execution State

Current phase:
Phase 10 - Final packaged-product acceptance and soak complete on implementation SHA `62f9095e570c406d6483ed688a0c21008ebe50f1`; exact-head workflow synchronization for this documentation checkpoint remains the final gate.

Current subphase:
Final documentation checkpoint and all three GitHub workflows on that exact commit.

Phase 10 implementation checkpoint:
62f9095e570c406d6483ed688a0c21008ebe50f1

Working tree before this documentation update:
Clean; `HEAD == origin/main == 62f9095e570c406d6483ed688a0c21008ebe50f1`.

## Phase 10 final acceptance evidence

- Persistent host policy verification: PASS. AppArmor `/etc/apparmor.d/containers/war-browser-agent` is root-owned mode `0644`, SHA-256 `0d28cf5e412992d3cb1bc8759bb6cf9cf1602e9aee54ebef52046f3f9b9b710d`, loaded as `war-browser-agent (enforce)`. Seccomp `/etc/war/security/chromium-userns-seccomp.json` is root-owned mode `0644`, parses as JSON, and has SHA-256 `e11ad80b10af89cdade31962005da51dae8cd8828c0d9c02dadf67008aa5181d`.
- Disposable policy-bound probe: PASS with non-root UID `1001`, AppArmor enforce, seccomp mode `2`, bridge network, private PID namespace, no mounts, no capability additions, no privileged mode, and no unconfined/bypass option.
- Managed-container lifecycle: PASS for Add, status, Stop, Start, Restart, Duplicate, Delete, authenticated WSS online state, exact SSH identity options, exact policy paths, bounded resources, loopback-only published control port, active Chromium sandbox, and cleanup on the final implementation SHA. Evidence: ignored runtime artifact `phase10-managed-acceptance-1784833772124.json` using `war-browser-agent:phase10-6e0be39`.
- Managed product path: PASS for real Browser Agent/Chromium/MV3/Native Messaging execution, exact clipboard match, cancel and duplicate cancel, grouped text/table/cell dispatch, three graph revision save/execute cycles with every previous revision preserved, three origin pull cycles including repeated-pull idempotency, offline same-job replay exactly once, Agent restart persistence, Controller restart persistence, and cleanup. Evidence: ignored runtime artifact `phase10-managed-product-1784445868094.json`.
- Required soak matrix: PASS for 20 successful dispatches, 5 Agent/container restarts, 3 Controller restarts, 5 offline replay cycles, 5 running cancellations, and 3 disconnect-during-execution cases. Duplicate execution/device/session, lost terminal result, and unsandboxed-cycle counts are zero. Evidence: ignored runtime artifact `phase10-soak-1784444918548.json`.
- Negative security: PASS for wrong TLS trust, wrong TLS hostname/endpoint, missing authorization, wrong credential, unpaired Agent, revoked credential, terminal replay count zero, and cleanup. The WSS gate now makes these cases mandatory.
- Local final regression: `npm.cmd run test:all` (226/226), WSS gate (`wss-gate-1784833851028.json`), Controller-to-Extension Edge E2E (`controller-extension-e2e-1784833893846.json`), Electron smoke, package generation, packaged smoke, release bundle, release integrity, and release gate (`release-gate-1784833714174.json`) all pass on `62f9095`. Release integrity checks 79 artifacts with tamper detection and secret scan PASS.
- Source repairs pushed during Phase 10: `29e20aa68de6da640791141b119e47a493074ba6` adds explicit managed-Docker SSH identity/options and redacted runtime configuration; `8fe2706c8803f04cedfc092babbe7b004b8f3f79` expands mandatory WSS negative acceptance.

Phase 8 result:
PHASE_8_COMPLETE.

Phase 9 completed checkpoints:
- Phase 9A complete: official Node 24 action releases pinned by immutable SHA, checkout credentials disabled, hidden artifact files excluded, policy regression coverage added, and all three GitHub workflows passed without Node.js 20 action warnings.
- Phase 9B complete: `node_modules` is ignored and removed from the Git index while the lockfile-restored local installation remains operational; commit `1e0deac17a6885011548a04eee791814c21e560d` is pushed and synchronized.
- Phase 9C complete: tracked-path classification and repository hygiene enforcement cover installed dependencies, pilot artifacts, generated packages, browser profiles, runtime state, and private credential material. `build/icon.svg` is classified as `RELEASE_INPUT`; `profiles/sample-profile.json` is classified as a synthetic `TEST_FIXTURE`.

Node 24 Actions migration:
PASS. CI `29654204738`, Container Real World Gate `29654213429`, and Windows Release Gate `29654214558` passed on `9fa0c1af53921d7e887c71d3fa63da9854aebc73`; exact Node.js 20 action warning count is zero.

node_modules tracking:
Zero files under `node_modules/**` remain in the Git index. The local dependency tree was recreated with `npm.cmd ci` and remains ignored.

Security review:
Phase 9D review is closed with Critical 0 and High 0. Focused code/test evidence covers Electron isolation and sender validation; pairing/session authority and revocation; offline replay, exactly-once, and durable terminal outbox; malformed/bounded WSS and Native Messaging; keyboard release and clipboard policy; managed Docker arguments/image/seccomp allowlisting; active Chromium sandbox; bounded origin/grouped/graph operations; diagnostic redaction; release allowlists; and minimum-permission immutable GitHub Actions. Accepted medium limitations are broad Extension host access, no generic high-risk action classifier, unsigned development packages without external signing material, and no public-Internet deployment.

Release gate:
Current local release bundle contains 79 integrity-checked artifacts; tamper detection, package secret scan, packaged Controller smoke, Electron GUI smoke, and release gate pass. The three exact-head workflows pass on `9fa0c1af53921d7e887c71d3fa63da9854aebc73`.

Phase 9 local verification after documentation:
- `npm.cmd ci`: PASS; 0 vulnerabilities. npm reported only upstream deprecation notices.
- `npm.cmd run test:all`: PASS; all extension, platform, security-policy, workflow, and hygiene suites passed.
- WSS gate: PASS; TLS verification, replay, revocation, and cleanup passed.
- Controller-to-Extension Edge E2E: PASS; grouped input, graph edit, execution, cancel, replay, and cleanup passed.
- Electron smoke: PASS.
- Release integrity: PASS; 79 artifacts, tamper detection and secret scan pass.
- Packaged Controller smoke: PASS.
- Release gate: PASS.
- `npm.cmd audit`: PASS; 0 vulnerabilities.
- `npm.cmd ls --depth=0`: PASS; only the approved top-level runtime packages are present.
- Local Windows `test:container-real-world`: `BLOCKED_INFRASTRUCTURE` because Docker CLI is unavailable; the GitHub-hosted exact-SHA gate remains mandatory and is not replaced by this local result.
- Historical recovery checkpoint: SSH batch authentication passed with the explicit identity and Docker server `29.4.2`, but the reviewed policy was not yet installed at that time.
- Resolution: the reviewed AppArmor/seccomp files were subsequently installed persistently and the complete Phase 10 managed-container acceptance above passed.
- Phase 10 local WSS gate: PASS; TLS verification, replay, revocation, and cleanup passed on `9a0ee7563ad3ffe06ac1e99278cd431bbb462ef5`.
- Phase 10 local Controller-to-Extension Edge E2E: PASS; real Browser Agent/Chromium/MV3, grouped input, graph edit, execution, cancel, replay, and cleanup passed.
- Phase 10 local Electron smoke, packaged smoke, release integrity, and release gate: PASS.
- Phase 10 local Browser Agent soak: `BLOCKED_INFRASTRUCTURE` with `spawn docker ENOENT`; no soak success is claimed.

Final acceptance:
The complete secure Phase 10 product path, soak matrix, local regression, release gates, cleanup, and implementation Git synchronization pass. `MVP_READY_FOR_PERSONAL_LAN_USE` may be returned only after CI, Container Real World Gate, and Windows Release Gate pass on the exact final documentation commit.

Known blockers:
- No remaining Chromium sandbox blocker. GitHub Container Real World Gate `29654213429` passed at exact SHA `9fa0c1af53921d7e887c71d3fa63da9854aebc73` with probe classification `USERNS_SANDBOX_CAPABLE`, all 40 runtime/product assertions true, SUID false, user/PID/network/seccomp-BPF/TSYNC and overall sandbox true, bounded resources, canonical measured seccomp match, and no full seccomp JSON or detected secret category in the sanitized artifact.
- The Windows credential-file regression is repaired with a platform-aware identity comparison that retains strict type, symlink, size, and POSIX permission checks; CI and Windows full tests now pass.
- No remaining Phase 10 product or infrastructure blocker. Production signing material and public-Internet deployment remain outside the personal-LAN MVP scope.

Next exact action:
Commit and push this documentation checkpoint, run all three GitHub workflows on that exact SHA, verify Git synchronization/cleanliness, and return the final decision.

Remaining MVP work:
- Commit and push this documentation checkpoint, then pass exact-final-SHA GitHub CI, Container Real World Gate, and Windows Release Gate.

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
