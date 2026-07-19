# Personal LAN Setup

This guide prepares the Controller and one managed Browser Agent for a trusted personal LAN. It does not expose the product to the public Internet.

## Preconditions

- Use the reviewed release SHA and verify `release-manifest.json` plus `SHA256SUMS.txt`.
- Use a Linux Docker host that passes `npm run probe:chromium-sandbox-host` with `USERNS_SANDBOX_CAPABLE`.
- Install `platform/container/security/war-browser-agent.apparmor` as root-owned mode `0644` and load it with `apparmor_parser -r -W`.
- Keep `platform/container/security/chromium-userns-seccomp.json` unchanged; the repository validator locks its reviewed hash.
- Use TLS certificates whose private keys stay outside the repository and release bundle.

## Controller

Configure the packaged Controller with external environment/configuration:

```powershell
$env:WAR_CONTROLLER_WSS_ENABLED="1"
$env:WAR_CONTROLLER_WSS_HOST="<trusted-lan-bind-address>"
$env:WAR_CONTROLLER_ALLOW_LAN="1"
$env:WAR_CONTROLLER_TLS_CERT_PATH="<certificate-path>"
$env:WAR_CONTROLLER_TLS_KEY_PATH="<private-key-path>"
$env:WAR_CONTAINER_RUNTIME="ssh-docker"
$env:WAR_CONTAINER_SSH_TARGET="<dedicated-agent-host>"
$env:WAR_CONTAINER_SSH_IDENTITY_FILE="$env:USERPROFILE\.ssh\id_ed25519"
$env:WAR_CONTAINER_CONTROLLER_HOST="<controller-address-reachable-by-agent>"
$env:WAR_CONTAINER_CONTROLLER_CA_PATH="<controller-ca-path>"
$env:WAR_CONTAINER_SECCOMP_PROFILE_PATH="/etc/war/security/chromium-userns-seccomp.json"
$env:WAR_CONTAINER_IPV6_INTERFACE="<linux-interface-with-global-ipv6-64>"
```

The managed adapter invokes SSH with `-F NUL`, the configured identity, `IdentitiesOnly=yes`, `BatchMode=yes`, and `ConnectTimeout=10`; it never relies on the user SSH config. Do not place credentials, private keys, personal IP addresses, or SSH keys in source files. Pair each Agent through the Controller UI and store the one-time credential only in the managed Agent data volume.

`WAR_CONTAINER_IPV6_INTERFACE` is optional when the Docker host has exactly one unique global `/64` prefix; the adapter discovers its interface. Configure it when the host has multiple global prefixes. The default driver is `macvlan`. Use `WAR_CONTAINER_IPV6_DRIVER=bridge` only with a separately routed/delegated `/64`, normally together with `WAR_CONTAINER_IPV6_PREFIX=<prefix>/64`. Automatic provider-prefix changes require interface discovery rather than a static override.

## Stable managed IPv6

The Controller network settings expose independent IPv4 and IPv6 switches. At least one family must remain enabled. For an on-link IPv6 `/64`, enter an EUI-64 final suffix such as `a8bb:ccff:fedd:eeff`.

For an address such as `2001:db8:1234:5678:a8bb:ccff:fedd:eeff`:

- `2001:db8:1234:5678::/64` is the provider-controlled prefix;
- `a8bb:ccff:fedd:eeff` is the Controller-persisted EUI-64 suffix. It maps to the stable MAC `aa:bb:cc:dd:ee:ff`;
- choose a different suffix for each container on the same prefix;
- do not use `::1`, which is reserved for the managed Docker network gateway;
- after the provider prefix changes to `2001:db8:aaaa:bbbb::/64`, Start, Restart, or Apply network reconciles the address to `2001:db8:aaaa:bbbb:a8bb:ccff:fedd:eeff`;
- Refresh reports prefix drift without silently changing a running container.

When `WAR_CONTAINER_IPV6_INTERFACE` is configured, the adapter creates a labeled IPv6 `macvlan` on that interface, enables IPv6, and assigns the exact static address plus its EUI-64 MAC. This is the correct mode for an on-link ISP `/64`; the upstream router supplies reachability through normal neighbor discovery. If the host has a separately routed/delegated `/64`, set `WAR_CONTAINER_IPV6_DRIVER=bridge` and the adapter uses an IPv6-only bridge instead. IPv4, when enabled, uses a separate labeled private bridge. Neither mode uses host networking. A routed deployment still requires the upstream router to route the delegated `/64` to the Docker host.

## Managed container policy

The Controller-managed container must retain:

- user `war`;
- AppArmor `war-browser-agent`;
- reviewed constrained seccomp policy;
- only the labeled managed IPv4 bridge and/or labeled managed IPv6 bridge (`macvlan` for on-link `/64`, `bridge` for routed `/64`), plus a private PID namespace;
- memory `2g`, CPUs `2`, PID limit `512`;
- named `/data` volume and only the approved CA bind;
- no privileged mode, Docker socket, host home, host network/PID, or added capabilities;
- no `WAR_BROWSER_NO_SANDBOX=1`, `--no-sandbox`, or `--disable-sandbox`.

## Acceptance

Before relying on the LAN deployment:

1. Confirm the Agent is authenticated and uniquely paired.
2. Query Chromium sandbox status and require SUID false plus user/PID/network/seccomp-BPF and overall sandbox true.
3. Run the controlled workflow through Controller, WSS, Native Messaging, MV3, result persistence, clipboard verification, cancel, replay, and restart cases.
4. Verify wrong credential, unpaired Agent, wrong TLS endpoint, revocation, and revoked reconnect are rejected.
5. Complete the soak matrix in `docs/MVP_ACCEPTANCE.md`.

## Cleanup

- Stop and remove managed containers through the Controller.
- Revoke retired Agents and remove their data volumes only through an intentional cleanup procedure.
- Unload temporary AppArmor test profiles with `apparmor_parser -R`.
- Remove temporary certificates, native-host registrations, screenshots, logs, and generated packages from test locations.
- Keep runtime artifacts ignored and untracked.

If a standard GitHub-hosted VM becomes incapable, do not weaken the sandbox. Use a disposable one-job Linux runner with no personal files or credentials, no pull-request trigger, `contents: read`, and destroy it after the job.
