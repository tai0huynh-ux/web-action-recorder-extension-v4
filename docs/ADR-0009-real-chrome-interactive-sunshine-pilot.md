# ADR-0009: Real Chrome interactive mode with one leased Sunshine session

## Status

Proposed for a measured pilot. This ADR does not authorize implementation and does not claim that Cloudflare, Google, CAPTCHA, or site policy can be bypassed.

## Context and non-goals

The current Browser Agent launches a headed CloakBrowser/Chromium process through Playwright and exposes remote tab, input, preview, extension, clipboard, and workflow controls. Some Cloudflare- and Google-protected pages challenge this control path.

The desired outcome is legitimate human control of a branded Google Chrome desktop while preserving the existing per-identity profile, extension functions, Native Messaging, container lifecycle, MAC address, public IPv6 allocation, and ISP-defined prefix behavior.

Sunshine and Moonlight are transport tools. They can carry video and human keyboard/mouse input to a real desktop. They do not change IP reputation, account history, request patterns, shared-prefix reputation, or site policy. The project must not add fingerprint spoofing, stealth patches, automated CAPTCHA handling, challenge solving, proxy rotation, address rotation, or traffic intended to evade a site's rules.

## Current evidence

- Cloudflare documents heuristics, machine learning, anomaly detection, JavaScript detections, headless browsers, and other automation tools as bot-score inputs.
- Google documents that unusual-traffic messages can result from automated traffic from the same network, VPN, or IPv6 tunnel. A direct Chrome desktop can reduce automation-specific signals but cannot repair network reputation.
- The WebDriver standard exposes a webdriver-active state. Removing Playwright/WebDriver from interactive site tabs removes one standard signal, not every possible signal.
- Sunshine supports Linux X11 and Wayland capture, hardware encoders, configurable ports, and multiseat input. Its documentation advises against multiple Sunshine instances.
- Sunshine's official Docker example maps `/dev/dri`, uses host IPC, and publishes a family of TCP and UDP ports. Linux input requires `/dev/uinput`; KMS capture requires `CAP_SYS_ADMIN`.
- Sunshine says its Docker image is experimental as a standalone container and is not recommended for most users. A containerized deployment is therefore conditional on a real pilot.
- The current extension manifest is keyless. Its approved ID `edoicfpldmlabgdalemfgflpldiijdmm` is derived from the canonical unpacked path `/app/extension`, while Native Messaging trusts that exact origin. A signed CRX or Web Store install cannot be assumed to preserve this path-derived ID.
- `recoverStaleChromiumProfileLocks()` only proves a live lock owner when its hostname matches the current container. A second container with a different hostname could otherwise remove another container's Chromium locks. A cross-mode profile lease is a hard prerequisite.

Measured on the Linux host on 2026-08-09:

- Intel Core i3-4130T, 2 cores / 4 threads.
- 15 GiB RAM and 4 GiB swap.
- Intel 4th-generation integrated GPU with `/dev/dri/renderD128`; hardware encoding capability is not yet proven because `vainfo` and `intel_gpu_top` are not installed on the host.
- `/dev/uinput` exists but is `0600 root:root`, so a non-root interactive container cannot use it under the current runtime policy without a narrowly reviewed host permission or interactive-only bootstrap design.
- The accepted image is 653,460,993 bytes. One active container measured about 375.9 MiB cgroup memory and 9.25 percent CPU at one sample. These are point measurements, not capacity results.
- The accepted managed runtime is non-root, private IPC, no devices, no added capabilities, no published ports, 2 GiB memory, 2 CPU, and 512 PIDs. Sunshine cannot be added by silently weakening this attestation.

## Options considered

### A. Keep the current Playwright/CDP control path for every session

This is the lowest-cost option and retains all accepted gates, but it does not provide a normal human desktop path and leaves the current automation surface in place.

### B. Run Sunshine in every browser container

Reject. This multiplies compositor, encoder, pairing, port, DRM, and input-device boundaries. The host has only two physical cores, Sunshine advises against multiple instances, and no encoder-capacity evidence exists.

### C. Install one host-level Sunshine/compositor service

Defer. It may be resource-efficient, but it violates the requirement that Linux application software live inside immutable images and increases the host compromise boundary. It also complicates routing one input stream to the correct per-container display and identity network.

### D. Start one on-demand interactive container under an exclusive lease

Recommend for the pilot. Many managed browser containers can remain available, but only the selected identity receives an interactive runtime with Chrome, display capture, GPU encoding, input, pairing state, and Sunshine ports.

The interactive session is a separate capability class, not the managed Browser Agent with extra devices. It must have a technical human-only boundary: no Controller workflow dispatch, page/input/capture/clipboard command, HTTP control listener, or generic browser-control endpoint may be reachable while the lease is interactive.

## Image and runtime decision

Prefer two immutable runtime targets built from one reviewed Dockerfile and shared base layers:

- `managed`: the currently accepted CloakBrowser image and runtime policy remain unchanged.
- `interactive`: a separately attested image that adds pinned Google Chrome Stable, Sunshine, the interactive display stack, and diagnostic tools required by the pilot.

All Linux application software remains inside images; nothing such as Chrome, Sunshine, `vainfo`, or a desktop package is installed directly on the host. Docker stores shared content-addressed base layers once, so separate digests do not duplicate every layer for every container. The current managed digest remains the rollback artifact.

A single dual-mode digest is a fallback only if the user makes one digest a hard requirement. It must still have separate entrypoints, SBOM/attestation, runtime policies, and device/port grants. It is not preferred because adding Chrome and Sunshine expands the trusted payload of every managed container even when dormant.

Host integration cannot be literally zero: Docker networks, AppArmor/seccomp policy, `/dev/dri`, `/dev/uinput` permission, firewall rules, and port publication are host-level configuration. The requirement is feasible as "no application packages installed on the host," not as "no host configuration changes."

## Interactive session design

### Real Chrome process

- Launch a pinned, integrity-verified Google Chrome Stable binary directly as a normal headed process.
- Do not attach Playwright, WebDriver, Puppeteer, or a generic CDP controller to affected interactive site tabs.
- Keep workflow automation in managed mode. Interactive mode must not start or expose the Browser Agent WSS/HTTP control surfaces, workflow upload/dispatch, remote input, screenshot, or clipboard APIs.
- The interactive Native Messaging policy is health-only. It must deny execution dispatch, workflow synchronization, capture, clipboard, and browser-control requests with a typed `interactive_mode_denied` result. Negative tests must prove every denied command has no side effect.
- During a protected-page challenge, the operator uses Moonlight keyboard/mouse input. The extension may remain installed for its user interface and health display, but automated execution is unavailable until Chrome is stopped and the identity safely returns to managed mode.
- Use a private/internal image unless Chrome redistribution licensing is reviewed for any wider registry publication.

### Extension distribution and identity migration

Use two distinct gates rather than pretending the current ID can be preserved automatically:

1. Transport-only pilot: direct Chrome may attempt to load the current canonical unpacked extension path to prove Sunshine, human input, health-only Native Messaging, profile continuity, and same-ID behavior. Branded Chrome 150 already ignored `--load-extension` in the recorded Windows gate, so failure is expected and sends the pilot directly to the signed migration path. Development loading cannot satisfy production acceptance.
2. Production candidate: package the extension with a dedicated protected signing key or publish through an approved managed channel, then install it with `ExtensionInstallForcelist` or `ExtensionSettings` and verify `chrome://policy` reports success.

Because the existing extension is keyless and path-derived, the production candidate requires a reviewed ID migration unless a supported method proves otherwise. Do not bulk-copy `chrome.storage.local`: it contains Companion enrollment/device tokens and a durable terminal outbox. Re-enroll the new extension identity and migrate only a versioned allowlist of workflows, library data, and non-secret settings. The private signing key must remain outside the repository, image, diagnostics, and Controller renderer.

Generate Chrome policy, Browser Agent configuration, and the Native Messaging manifest from one signed extension-artifact metadata source. Each runtime image must assert exactly one approved extension origin. Migrate by stopping the old image, exporting allowlisted state, and starting the new image; do not keep simultaneous old/new origins as a permanent compatibility path. If exact current-ID preservation is mandatory, production managed installation is blocked until that conflict is resolved.

### Profile single-writer fence

- Each identity keeps its exact `/data` volume, MAC, IPv6 suffix, ISP prefix, and network attachments.
- Before either managed or interactive Chrome starts, acquire an atomic exclusive lease held for the browser lifetime. The lease contains an identity ID, opaque lease token, monotonic generation, mode, Controller owner, and start time.
- Both entrypoints must obtain `flock` on the identity-volume lease file and verify the same token/generation recorded by the Controller before launching Chrome. A stale Controller record never authorizes lock deletion or a generation change by itself.
- Never mount one profile concurrently and never copy a live profile.
- Stop Chrome cleanly, verify the browser process exited, release the lease, and only then switch modes.
- Do not delete Chromium `Singleton*` locks merely because another container hostname cannot validate them. Recovery must first prove that no lease holder and no browser process can own the profile.
- After a crash or partition, a new lease increments the generation only after Docker reports no identity container running and an exclusive filesystem lock is acquired. Both entrypoints reject old tokens and generations.
- Test the transaction and lock on the actual Docker volume filesystem and fail closed if its semantics are not reliable.

### Sunshine, display, and input

- Start Sunshine only while one operator holds the exclusive interactive lease. Use one fixed Sunshine port family and one pairing-state volume separate from browser profiles.
- For the measured pilot, publish TCP `47984-47990` and `48010`, and UDP `47998-48000`, only on Linux LAN IPv4 `192.168.1.201`. Firewall the source initially to Moonlight client `192.168.1.206/32`; adding another client requires explicit enrollment and an allowlist update.
- Do not bind Sunshine or its web UI to `0.0.0.0`, public IPv6, the browser container's public IPv6, or a wildcard interface. Disable UPnP. Test that non-allowlisted LAN clients and public-IPv6 paths cannot connect.
- Pairing requires an explicit operator approval. Support listing and revoking paired clients, rotate pairing credentials after suspected compromise or rollback, and redact certificates, PINs, and client secrets from logs and renderer state.
- Prefer a separate Sunshine transport process/container that has no `/data` profile mount. Its pairing volume is owned by a Sunshine-only UID with mode `0700` and is denied to Chrome and the extension by mount layout and AppArmor. If a shared container is tested, an access-denial test must prove the Chrome process cannot read or modify pairing state.
- Keep browser egress on the identity's existing IPv6 network so streaming does not alter public browser identity.
- Start with 1280x720, 30 FPS, H.264, wired LAN, and `/dev/dri/renderD128` only. Do not expose the DRM card node unless measurement proves it is required.
- First try X11 capture against the current virtual display with private IPC and an explicit shared-memory size. Verify that Sunshine input actually reaches only the selected display.
- If X11/Xvfb input isolation or capture fails, test a nested Wayland compositor with `wlr` or portal capture inside the interactive image.
- Reject KMS capture for the initial pilot because it requires `CAP_SYS_ADMIN`.
- Do not accept `--ipc=host` merely because the upstream Docker example uses it. If private IPC fails, document the exact failure and require a new security review before broadening the boundary.
- `/dev/uinput` is host-wide input injection; device cgroups and AppArmor do not make its events display-scoped. The pilot must either use a reviewed per-session input broker that emits only into the selected private display, or place the interactive desktop in a VM/microVM with its own kernel and uinput device. Direct host `/dev/uinput` passthrough is not accepted.
- If neither input-isolation option works within the resource budget, reject Sunshine-in-container rather than add root, `CAP_SYS_ADMIN`, wildcard device access, or the Docker socket.
- The interactive attestation retains `cap-drop=ALL`, exposes only `/dev/dri/renderD128` if required, exposes no DRM card node, and has no privilege-escalation fallback.
- If the Controller lease heartbeat expires, stop accepting input and terminate the Sunshine session after a short bounded grace period. Recovery must still stop Chrome cleanly or leave the profile fenced for manual repair.

## Resource-density strategy

- Store Chrome, Sunshine, and extension files in shared immutable image layers. Per-container writable storage is limited to the identity profile, downloads, logs, and small runtime state.
- Do not run Sunshine, a hardware encoder, or high-rate preview in background containers.
- Keep one interactive stream while ordinary managed containers remain independently networked. Pause or reduce Controller JPEG preview for non-selected containers.
- Apply explicit cgroup limits to the interactive container and measure impact on a managed-container control workload at the same time.
- Do not use fingerprint-changing performance flags, proxy changes, locale spoofing, or address rotation as resource optimizations.
- Attempt a second interactive stream only after the first stream and the background-container matrix meet every threshold. The likely first limit on this host is CPU or encoder capacity, not RAM.

## Pilot phases

### Phase 0: disposable transport and encoder benchmark

1. Build the interactive image without changing the accepted managed image.
2. Verify Chrome version and checksum, direct launch with no WebDriver attachment, extension health, Native Messaging, virtual display, Moonlight pairing, input isolation, and LAN-only ports.
3. Verify VAAPI H.264 support from inside the image and record the exact driver/codec result.
4. Prove every managed command surface and every non-health Native Messaging operation is denied in interactive mode with no side effects.
5. Prove Sunshine and Chrome cannot read each other's protected credentials or profile/pairing volumes beyond the explicitly shared display socket.
6. Run one 720p30 H.264 stream for at least 30 minutes and record cold/warm start, P50/P95 input-to-photon latency, dropped frames, CPU, RAM, GPU/encoder utilization, and disconnect recovery.
7. Stop if encoding falls back to sustained software saturation, input reaches another session, or unaccepted privileges are required.

### Phase 1: extension packaging and one identity capsule

1. Decide and document unpacked pilot identity versus signed production identity.
2. Prove the managed Chrome policy path, extension ID, Native Messaging origin, extension state migration, and rollback on a disposable profile before touching a real identity.
3. Add and test the atomic cross-mode profile lease.
4. Run at least 20 managed-to-interactive-to-managed cycles on one non-sensitive identity.
5. Prove no profile lock deletion, cookie loss, workflow loss, duplicate profile mount, Native Messaging failure, MAC change, or public IPv6 change.
6. Test Moonlight disconnect, Controller loss, Chrome crash, container restart, and Linux restart.

### Phase 2: consented challenge-rate evaluation

1. Use only legitimate, human-operated flows on sites the user is authorized to access.
2. Compare the current headed managed mode with direct-Chrome interactive mode using the same network identity and a predeclared alternating schedule.
3. Record challenge presentation and completion outcome; never automate the challenge itself.
4. Use repeated sessions rather than `navigator.webdriver`, one screenshot, or one successful page as acceptance evidence.
5. Predeclare at least 30 authorized sessions per mode and alternate the two modes over comparable time windows. The proposed material-improvement threshold is at least a 30 percentage-point increase in legitimate task completion, reported with a Wilson confidence interval; insufficient evidence is not a pass.
6. Treat no material improvement as a valid negative result: Sunshine is not accepted merely because streaming works.

### Phase 3: bounded density

1. Increase idle and normally active managed containers while keeping one interactive stream.
2. Measure a representative managed command/control workload concurrently with the stream.
3. Define supported density at the first P95 latency, frame-drop, CPU, memory, encoder, or managed-workload regression breach.
4. Attempt a second interactive stream only after a new explicit approval.

## Proposed acceptance gates

- Chrome is pinned, integrity-verified, and reported as the expected branded stable build.
- Interactive affected-site tabs have no Playwright/WebDriver/Puppeteer/generic-CDP attachment.
- Interactive mode exposes health only: all Controller workflow, remote browser, screenshot, capture, input, and clipboard paths are technically denied and negative-tested.
- Production extension installation uses a supported managed path; any ID and state migration is explicit, tested, and reversible.
- Native Messaging accepts only the reviewed extension origin. Managed-mode workflow gates remain green; interactive mode passes health plus typed execution-denial gates.
- The same identity volume, MAC, and observed public IPv6 survive 20 fenced lease cycles and failure recovery.
- Zero duplicate profile mounts, stale-generation starts, cross-container `Singleton*` deletions, cross-session input events, public Sunshine exposure, or UPnP mappings occur.
- Sunshine ports bind only to `192.168.1.201`, initially accept only `192.168.1.206/32`, and reject non-allowlisted LAN and all public-IPv6 probes.
- Chrome cannot read Sunshine pairing state; Sunshine cannot mount the browser profile; pairing approval, revocation, rotation, and redacted diagnostics pass.
- One 720p30 H.264 session runs for 30 minutes with less than 1 percent dropped frames, P95 input-to-photon latency at or below 150 ms on wired LAN, host CPU P95 below 80 percent, and no 60-second interval above 90 percent.
- The concurrent managed control workload has no more than 20 percent P95 latency regression and no functional failures.
- Manual affected-site trials show a predeclared material improvement over the current baseline. If they do not, the proposal is rejected or redesigned.
- Existing managed-container security, physical LAN, container real-world, Controller-to-Extension E2E, packaged Controller, and release gates remain green.

## Rollback

1. Disable the interactive feature flag and refuse new leases.
2. Stop Sunshine and Chrome, confirm the profile lease is released, and retain diagnostic evidence without page or clipboard secrets.
3. Recreate the identity from the previously accepted managed image using the same `/data` volume and network allocation.
4. Restore the old extension/native-origin state if an ID migration was attempted.
5. Remove interactive-only device, port, firewall, AppArmor/seccomp, and pairing grants without altering browser profiles or IPv6 networks.

## Decision invalidators

Reject or redesign the pilot if any of these occur:

- The profile lease cannot prevent concurrent mounts and unsafe Chromium lock cleanup.
- Interactive mode cannot technically deny all non-human control and workflow capabilities.
- Extension functions, state, or Native Messaging cannot survive a supported Chrome installation and migration path.
- Sunshine requires public exposure, Docker socket access, broad host filesystem access, host PID/network namespaces, or unbounded privileges.
- X11/Wayland input cannot be isolated to the selected interactive session without direct host-wide uinput passthrough.
- The Intel iGPU cannot provide stable hardware H.264 encoding at 720p30.
- A single interactive session materially harms ordinary managed containers.
- Human-operated challenge rates do not materially improve over the current headed baseline.

## Primary sources

- Cloudflare bot score: https://developers.cloudflare.com/bots/concepts/bot-score/
- Google unusual traffic: https://support.google.com/websearch/answer/86640?hl=en
- W3C WebDriver active flag: https://w3c.github.io/webdriver/#dfn-webdriver-active-flag
- Sunshine getting started: https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2getting__started.html
- Sunshine configuration: https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2configuration.html
- Sunshine troubleshooting and multiseat: https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2troubleshooting.html
- Sunshine Docker guidance: https://github.com/LizardByte/Sunshine/blob/master/DOCKER_README.md
- Moonlight setup guide: https://github.com/moonlight-stream/moonlight-docs/wiki/Setup-Guide
- Chromium ExtensionInstallForcelist definition: https://github.com/chromium/chromium/blob/main/components/policy/resources/templates/policy_definitions/Extensions/ExtensionInstallForcelist.yaml
- Chromium ExtensionSettings definition: https://github.com/chromium/chromium/blob/main/components/policy/resources/templates/policy_definitions/Extensions/ExtensionSettings.yaml
- Chrome extension installation policies: https://support.google.com/chrome/a/answer/7532015?hl=en
