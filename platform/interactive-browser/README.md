# Interactive Google Chrome Realtime Runtime

This is the Controller's default human-control runtime when a Moonlight endpoint is configured: official Google Chrome Stable runs on Xvfb and Sunshine provides LAN streaming with native pointer and keyboard input. It is **not** a challenge bypass or an automation backend. The managed CloakBrowser image remains available only for workflow automation and explicit rollback. Installing the Web Action Recorder extension is a separate acceptance gate. No site access is promised by this artifact.

`compose.yml` starts two containers from the same `war-interactive-chrome-pilot` image. `interactive-chrome-pilot` uses the fixed hostname `war-interactive-chrome-pilot`, is attached **only** to the already-created IPv6-only macvlan named by `WAR_PILOT_NETWORK_NAME` (default `war-interactive-ipv6`), and runs Chrome plus Xvfb. The fixed hostname lets Chrome safely recognize and recover its own orphaned `SingletonLock` after a container recreation; only one container may mount the profile. The active profile is `pilot-chrome-profile-v2`. During the one-time migration, copy the stopped legacy profile into this new volume while excluding only the three root runtime symlinks `SingletonLock`, `SingletonCookie`, and `SingletonSocket`; keep the legacy volume unchanged as rollback and never mount both identities concurrently. `interactive-sunshine-pilot` uses the distinct fixed hostname `war-interactive-sunshine-pilot`, is attached **only** to the IPv4 `pilot-ingress` bridge, and publishes Sunshine on the explicit private LAN IPv4 `192.168.1.201` by default. The fixed Sunshine hostname and persistent state volume preserve Moonlight pairing identity across container recreation. The bridge is non-internal so Docker can install the host DNAT rules, while IP masquerading is disabled so the sidecar does not receive general IPv4 Internet egress through the host. Docker does not publish ports from a container with a macvlan endpoint, so the split is mandatory. The services share the named `pilot-x11-socket` volume and the Chrome/Xvfb IPC namespace at `DISPLAY=:99`; the shared IPC namespace is required for X11 MIT-SHM capture. Sunshine waits up to 10 seconds for Xvfb before it starts.

Chrome data is persisted only in `pilot-chrome-profile-v2`. Sunshine pairing/configuration state is persisted only in `pilot-sunshine-state`, mounted at its normal per-user config directory. Change the host binding with `WAR_PILOT_BIND_ADDRESS`; wildcard, loopback, public IPv4, and IPv6 host publications are rejected by the runtime contract. Runtime acceptance must prove Chrome IPv4 Internet egress fails while IPv6 succeeds, and must separately prove the Sunshine sidecar cannot initiate general IPv4 Internet traffic. Disabling bridge masquerading is not a firewall and assumes the LAN has no route to the Docker bridge subnet. Sunshine is IPv4-only, advertises H.264-friendly 1280x720 at 30 fps, and has UPnP disabled. Required ports are TCP 47984/47989/47990/48010 and UDP 47998-48000.

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

Stop the runtime with `docker compose -f platform/interactive-browser/compose.yml down`. Do not add `-v`: the Chrome profile and Sunshine pairing volumes are persistent state and must remain available for restart and rollback.
