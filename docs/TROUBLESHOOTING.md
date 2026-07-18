# Troubleshooting

## Chromium reports Operation not permitted

Run:

```bash
npm run probe:chromium-sandbox-host
```

Interpret category-only results:

- `HOST_USERNS_RESTRICTED`: host sysctls disable unprivileged user namespaces.
- `HOST_APPARMOR_DENIED`: the exact reviewed Chromium transition is not loaded or not selected.
- `DOCKER_SECCOMP_DENIED`: the constrained seccomp policy was not applied or no longer matches Chromium's required namespace masks.
- `NO_NEW_PRIVILEGES_CONFLICT`: no-new-privileges blocked the reviewed AppArmor child-profile transition.
- `RUNNER_NESTING_UNSUPPORTED`: an outer container or nested runner blocks required namespaces.
- `CHROMIUM_CONFIG_INVALID`: forbidden sandbox flags are present.
- `UNKNOWN_NAMESPACE_DENIAL`: evidence is insufficient; do not classify this as a product pass.

`HOST_UNSUPPORTED` means the host cannot run the reviewed architecture without a host-policy change or a disposable capable runner. `PRODUCT_BUG` means the host probe is capable but the managed runtime, Chromium authoritative status, or product path fails.

Never use privileged mode, host network/PID, broad capabilities, Docker socket/host-home mounts, AppArmor/seccomp unconfined, `--no-sandbox`, or `--disable-sandbox` as an acceptance fix.

## Probe passes but real-world gate fails

- Inspect only the sanitized artifact and failed assertion names.
- Confirm Docker inspect reports the loaded seccomp JSON; the gate verifies its canonical policy hash and must not persist the full JSON.
- Confirm `chrome://sandbox` reports every required boolean and SUID false.
- Rebuild the Browser Agent image for the exact source SHA.
- Verify the MV3 Native Messaging manifest and Agent socket share the same `WAR_DATA_DIR` runtime path.

## Native Messaging host not found

- Confirm the system manifest exists at the browser-supported location.
- Confirm its `allowed_origins` contains only the approved Extension ID.
- Confirm the native host executable/runtime path exists and is executable.
- Restart Chromium once after installing a new manifest, then rerun the bridge health preflight.

## Packaged Controller gate fails

Run `test:release:integrity` and `test:controller-electron:packaged` separately. Do not run packaged smoke and the aggregate release gate concurrently because Electron single-instance locking can make a healthy package look failed.

## Local Windows container command fails

If Docker is unavailable on Windows, do not convert the result to PASS. Use the exact-SHA GitHub Container Real World Gate or a reviewed disposable Linux host and record which environment supplied the accepted evidence.
