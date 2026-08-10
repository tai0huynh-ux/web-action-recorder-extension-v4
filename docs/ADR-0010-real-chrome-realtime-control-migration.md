# ADR-0010: Real Chrome and realtime human control migration

Status: proposed pilot implementation

Date: 2026-08-10

## Context

The managed Browser Agent currently uses an immutable CloakBrowser executable through
Playwright and X11/CDP input. The renderer receives bounded JPEG snapshots and sends
individual input commands. The requested user experience is a real Google Chrome
desktop controlled by a human in realtime, including pointer movement, drag gestures,
and keyboard key-down/key-up state.

Replacing the managed runtime in one step would combine two different capabilities:
workflow automation and human desktop interaction. It would also make rollback,
profile ownership, extension identity, and the IPv4-controller/IPv6-container split
ambiguous. Chrome, Sunshine, and the extension must remain inside immutable images;
application packages must not be installed on the Linux host.

## Decision

Use two explicit runtime modes:

* `managed`: the existing CloakBrowser image, Browser Agent WSS, workflow APIs, and
  JPEG/CDP/X11 compatibility path. This is the rollback target and remains unchanged
  until the interactive gates pass.
* `interactive`: a separate immutable image containing pinned Google Chrome Stable and
  Sunshine. Each pilot instance runs two containers from that image: Chrome/Xvfb and a
  Sunshine sidecar sharing only the X11 socket. One selected identity receives an
  exclusive lease for the lifetime of the Chrome profile and Sunshine session. The
  human uses Moonlight/Sunshine for live video and native pointer/keyboard input;
  effectful Controller workflow, remote-input, capture, clipboard, and Native Messaging
  commands are denied in this mode. Health is allowed.

The interactive image is a pilot capability, not an anti-bot bypass. Human-operated
  challenge pages remain subject to Google, Cloudflare, and site policy. No CAPTCHA,
  fingerprint spoofing, proxy rotation, or challenge automation is part of this ADR.

The Controller continues to use IPv4 LAN for its own endpoint. The Chrome container has
only the identity's IPv6-only macvlan. Docker macvlan does not support port publishing,
so Sunshine runs as a sidecar attached only to a non-internal Docker bridge and shares
the X11 Unix socket with Chrome/Xvfb. The bridge disables IP masquerading: Docker can
still install host DNAT rules for the explicit LAN IPv4 publications, while the sidecar
does not receive general IPv4 Internet egress through host SNAT. This assumes the LAN
has no route to the bridge subnet and is verified at runtime rather than treated as a
firewall guarantee. The Chrome network namespace has no IPv4 interface or fallback,
Sunshine has no public IPv6 interface, and UPnP remains disabled.

## Rejected alternatives

* Making Chrome CDP screencast the primary video path: it is a debugging stream with
  acknowledgement/backpressure and Base64 CPU overhead, not a desktop transport.
* Running Sunshine in every managed container: the current Linux host is CPU/GPU
  limited and the pairing, port, and device boundary would multiply per container.
* Passing `/dev/uinput` to ordinary containers: uinput is host-wide and is not display
  scoped. A per-session broker, nested compositor, or VM is required before it can be
  considered.
* Building a custom WebRTC/WebSocket media stack in this checkpoint: it would recreate
  codec, ICE/TURN, DTLS, backpressure, reconnect, and authentication concerns without
  a demonstrated benefit.

## Staged migration

1. **Contract checkpoint**: validate the interactive mode policy, profile lease token /
   generation, explicit Sunshine LAN bind, and IPv6-only network assumptions.
2. **Transport checkpoint**: connect one leased identity to Sunshine/Moonlight and
   measure pointer/keyboard input-to-photon latency, frame drops, and reconnect time.
3. **Controller checkpoint**: expose an explicit human-only interactive action and
   connection descriptor. If the native Moonlight client is unavailable, show
   `NOT_CONFIGURED`; never silently fall back to command injection.
4. **Extension/profile checkpoint**: install the extension through a supported Chrome
   policy or signed package, re-enroll Native Messaging, and migrate only an allowlisted
   subset of non-secret state. Never copy `chrome.storage.local` wholesale.
5. **Density checkpoint**: support one interactive stream first, then measure its impact
   on managed containers before considering a second stream.

## Acceptance gates

* Chrome version and package digest are pinned and verified; `chrome://sandbox` passes.
* Interactive Chrome has no Playwright/WebDriver/Puppeteer or generic CDP attachment.
* Twenty managed-to-interactive-to-managed lease cycles, plus crash, partition, and
  restart recovery, show no concurrent profile mount, unsafe Singleton lock deletion,
  MAC change, or public IPv6 change.
* The Chrome container has only public IPv6 egress; the Sunshine sidecar listens only
  on the private ingress bridge. Docker publishes TCP
  `47984/47989/47990/48010` and UDP `47998-48000` on the configured LAN IPv4, and
  non-allowlisted clients and public exposure are rejected; UPnP is disabled.
* One 1280x720 H.264 stream runs for 30 minutes with less than 1% dropped frames,
  input-to-photon P95 at or below 150 ms on wired LAN, host CPU P95 below 80%, and no
  60-second interval above 90%.
* Managed control workload P95 latency regresses by no more than 20% and has no
  functional failures while the interactive stream is active.
* Existing Browser Agent, Controller-to-Extension E2E, packaged smoke, release, and
  physical-LAN gates remain green.

## Rollback

Disable new interactive leases, stop Chrome/Sunshine, verify lease release, restore the
accepted CloakBrowser image with the same data volume and network allocation, and remove
interactive-only ports, device mappings, and pairing state. Do not delete a profile or
Chromium Singleton lock without proving that no lease holder or browser process exists.

## Primary sources

* https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast
* https://docs.docker.com/engine/network/ipv6/
* https://docs.docker.com/engine/network/drivers/bridge/
* https://docs.docker.com/engine/network/port-publishing/
* https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2getting__started.html
* https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2configuration.html
* https://github.com/LizardByte/Sunshine/blob/master/DOCKER_README.md
* https://github.com/moonlight-stream/moonlight-docs/wiki/Setup-Guide
