# Disposable Interactive Chrome Pilot

This is a disposable, human-only pilot image: official Google Chrome Stable runs on Xvfb and Sunshine provides LAN streaming. It is **not** a challenge bypass, an automation backend, or a replacement for the managed CloakBrowser image. Installing the Web Action Recorder extension is a separate, explicit acceptance gate. No site access is promised by this artifact.

The Compose file joins an already-created external network named by `WAR_PILOT_NETWORK_NAME` (default `war-interactive-ipv6`); it never creates or changes the managed network. The IPv6-only container listens on `::`; Docker host publication is separately fenced to the explicit private IPv4 `192.168.1.201` by default and can be changed with `WAR_PILOT_BIND_ADDRESS`. Wildcard, loopback, and public IPv6 host binds are rejected by the runtime contract. Sunshine uses H.264-friendly 1280x720 at 30 fps with UPnP disabled. Typical ports are TCP 47984/47989/47990 and UDP 47998-48000.

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
