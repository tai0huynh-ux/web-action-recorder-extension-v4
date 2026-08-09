# ADR-0008: Pinned CloakBrowser image and privileged clipboard bridge

## Status

Accepted for implementation and real-container validation.

## Context

Managed Linux hosts must not install browser or application packages outside the managed image. The Controller must preserve the existing Docker volume, LAN discovery, IPv4/IPv6 allocation, WSS session, MV3 extension, Native Messaging, and remote-input behavior while replacing the production Chromium executable with CloakBrowser.

The `cloakbrowser` JavaScript wrapper is not a safe runtime launcher for this platform. Version `0.5.5` adds `--no-sandbox` in its default stealth arguments and owns binary download, update, cache, and license behavior. Those defaults conflict with the measured AppArmor and user-namespace sandbox boundary.

Remote clipboard transfer also crosses a high-value data boundary. Clipboard text must never be exposed to the Electron renderer, diagnostics, logs, caches, or persisted controller state.

## Decision

- The private Linux image downloads CloakBrowser only during image build.
- The build pins wrapper `0.5.5`, binary `146.0.7680.177.5`, and Linux x64 archive SHA-256 `4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e`.
- The build verifies the vendor-signed `SHA256SUMS` manifest and its pinned archive digest before accepting the binary.
- Runtime uses `playwright-core` directly with the immutable binary at `/opt/war/cloakbrowser/chromium-146.0.7680.177.5/chrome`. Runtime does not import the vendor wrapper, download updates, contact a license service, or receive a CloakBrowser license key.
- The production image contains no Debian Chromium package. Rollback selects the prior immutable Chromium image; it is never a silent in-process fallback.
- The `/data/chromium-profile` path remains unchanged so cookies, extensions, settings, and browser state continue to use the existing volume.
- AppArmor transitions only the root-owned CloakBrowser launcher into the reviewed browser child containing the single `userns` grant. Browser processes cannot access Agent identity, workflow, clipboard-helper, X11-input, or runtime-socket paths directly. The exact native host transitions again into a nested profile that can access only the Native Bridge socket and its read-only runtime files.
- The reviewed seccomp profile retains Docker's deny-by-default baseline and adds only the measured `clone`, `unshare`, and `chroot` rules required by the CloakBrowser user-namespace sandbox. Its canonical content and AppArmor bytes are hash-pinned by Controller readiness checks.
- The built-in Web Action Recorder extension identity is fixed to `edoicfpldmlabgdalemfgflpldiijdmm`. Native Messaging `allowed_origins` is never derived from an arbitrary installed extension.
- User-installed extensions are managed through the persistent profile and `chrome://extensions`. Remote code upload is not added.
- Remote-to-controller copy and controller-to-remote paste use dedicated Electron IPC channels. The main process alone reads or writes the OS clipboard. Renderer requests contain device IDs only and receive `{ copied|pasted, bytes }` metadata only.
- Clipboard text is strict UTF-8 and limited to 64 KiB at X11, Agent command, WSS protocol, Controller application, and Electron main-process boundaries. The protocol exception is restricted to the dedicated clipboard command shapes; the global 4 KiB string limit remains unchanged.
- The final image contains a root-owned, non-writable SBOM generator and CloakBrowser provenance. Post-build generation inventories installed dpkg and production npm packages inside the immutable image and emits an SPDX document plus a SHA-256 sidecar bound to the exact image ID.

## Threat-model boundary

The nested AppArmor profile prevents ordinary browser processes from opening or replacing the Agent socket directly. It does not prove the provenance of a process that can already execute the trusted Native Messaging host. A complete CloakBrowser process compromise with sandbox escape could invoke that host as a confused deputy and act through its permitted bridge. Acceptance therefore relies on the measured Chromium user-namespace sandbox to contain untrusted web content and does not claim containment of full browser-process RCE. Closing that stronger threat requires a separately reviewed broker or authority redesign.

## Licensing boundary

The official CloakHQ Binary License v1.3 was rechecked on 2026-08-08 at `https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md`. It permits storing and running the unmodified binary in internally controlled Docker images and internal artifact repositories. This decision assumes the Controller and its LAN browser sessions remain under the user's or organization's control; exposing browser control to third parties would require a separate OEM/SaaS review. The project does not redistribute the binary in public source archives, Windows releases, or third-party images. A successful download or image build proves artifact integrity, not subscription entitlement, so a newer major binary that requires a paid tier cannot replace the pin without a new license and security review.

## Consequences

- Image builds require network access to the official CloakBrowser release endpoints, but running containers do not.
- The image is larger, while Linux hosts remain free of project browser installations outside Docker.
- Browser upgrades are deliberate source changes with a new version, signed manifest, digest, AppArmor path, image labels, and full real-container acceptance.
- Clipboard copy is single-device and explicit. Paste targets only the explicitly selected devices and never uses renderer clipboard APIs.
- Containers receive the Linux host gateway alias only when the selected Controller endpoint is explicitly `host.docker.internal`; normal LAN Controller endpoints do not expose that route.

## Acceptance and rollback

Acceptance requires the authoritative `chrome://sandbox` result, fixed extension identity and Native Messaging health, per-tile tab/URL controls, extension management, two-way clipboard tests, restart persistence, unchanged volume and IPv6/MAC allocation, full Controller-to-Extension E2E, packaged Electron smoke, and the release gate.

Rollback recreates the container from the previously accepted immutable Chromium image and its previously accepted AppArmor profile while reusing the same `/data` volume and network configuration.
