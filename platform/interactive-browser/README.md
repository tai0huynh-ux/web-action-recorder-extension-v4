# Disposable Interactive Chrome Pilot

This is a disposable, human-only pilot image: official Google Chrome Stable runs on Xvfb and Sunshine provides LAN streaming. It is **not** a challenge bypass, an automation backend, or a replacement for the managed CloakBrowser image. Installing the Web Action Recorder extension is a separate, explicit acceptance gate. No site access is promised by this artifact.

The Compose file joins an already-created external network named by `WAR_PILOT_NETWORK_NAME` (default `war-interactive-ipv6`); it never creates or changes the managed network. Chrome uses that IPv6-only macvlan for Internet egress. Sunshine uses a second Docker bridge marked `internal`, listens on IPv4 only, and is published on the explicit private LAN address `192.168.1.201` by default. This split is required because Docker macvlan does not support port publishing. Change the host binding with `WAR_PILOT_BIND_ADDRESS`; wildcard, loopback, public IPv4, and IPv6 host publications are rejected by the runtime contract. Runtime acceptance must prove IPv4 Internet egress fails while IPv6 succeeds. Sunshine advertises H.264-friendly 1280x720 at 30 fps with UPnP disabled. Required ports are TCP 47984/47989/47990/48010 and UDP 47998-48000.

On Docker hosts that reject Chromium user/pid namespaces, run the disposable pilot with `WAR_PILOT_NO_SANDBOX=1` as a temporary compatibility mode. This is not an acceptance configuration for the managed CloakBrowser image; remove it once the host sandbox gate passes.

Optional `/dev/dri/renderD128` and `/dev/uinput` are runtime device mappings only. Add them in a local Compose override or with `docker run --device`; do not install host packages for this pilot.

## Build and run

```powershell
$env:WAR_PILOT_NETWORK_NAME = 'my-existing-ipv6-network'
$env:WAR_PILOT_SUNSHINE_DEB_SHA256 = '<release-sha256>'
docker compose -f platform/interactive-browser/compose.yml build --pull
docker compose -f platform/interactive-browser/compose.yml up
```

The Chrome package version and direct-download SHA256 are pinned by `WAR_PILOT_CHROME_VERSION` and `WAR_PILOT_CHROME_DEB_SHA256`; Sunshine is pinned by `WAR_PILOT_SUNSHINE_VERSION` and `WAR_PILOT_SUNSHINE_DEB_SHA256`. The build fails if either downloaded package does not match its expected digest.

## Health and benchmark

```powershell
docker compose -f platform/interactive-browser/compose.yml ps
docker compose -f platform/interactive-browser/compose.yml logs --no-color --tail=100
sunshine --help
# Human benchmark: connect one Sunshine client on the LAN and record 60 seconds at 720p30.
```

Stop and discard the pilot with `docker compose -f platform/interactive-browser/compose.yml down -v` when the human review is complete.
