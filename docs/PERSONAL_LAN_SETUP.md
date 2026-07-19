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
```

The managed adapter invokes SSH with `-F NUL`, the configured identity, `IdentitiesOnly=yes`, `BatchMode=yes`, and `ConnectTimeout=10`; it never relies on the user SSH config. Do not place credentials, private keys, personal IP addresses, or SSH keys in source files. Pair each Agent through the Controller UI and store the one-time credential only in the managed Agent data volume.

## Managed container policy

The Controller-managed container must retain:

- user `war`;
- AppArmor `war-browser-agent`;
- reviewed constrained seccomp policy;
- bridge network and private PID namespace;
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
