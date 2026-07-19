# Security Specification

This extension can read and modify web pages, record user actions, automate tabs, store profiles/logs, and optionally accept external commands. Treat it as a high-risk automation tool. Secure defaults are mandatory.

## Core principles

- **Least privilege by default:** request only the permissions needed for the currently enabled feature.
- **User-initiated automation:** recording and running must be explicitly started by the user unless a profile-level watcher is enabled.
- **Local-first control:** no public exposure, no cloud relay, and no LAN/Tailscale listener unless the user explicitly opts in.
- **Secret minimization:** do not record, store, display, export, or transmit secrets unless the user deliberately overrides protections.
- **Auditable behavior:** automation, external requests, denied requests, and sensitive settings changes must be visible in local logs.

## Manifest V3 permission minimization

Use Manifest V3 with the smallest practical permission set.

Recommended baseline:

- `storage` for profiles, settings, and local logs.
- `activeTab` for user-initiated capture/run on the current tab.
- `scripting` only when injecting content scripts on explicit user action or for granted hosts.
- `tabs` only if cross-tab workflows need tab metadata or tab switching.
- `commands` only for configured hotkeys.
- `alarms` only if watcher scheduling is implemented.
- `nativeMessaging` only if the native companion option is enabled.

Avoid broad permissions unless strictly required:

- Do **not** request `<all_urls>` at install time.
- Do **not** request `webRequest`, cookies, history, downloads, clipboard, debugger, or identity permissions for MVP unless a specific reviewed feature requires them.
- Do **not** inject content scripts into every page by default.

## Host permissions strategy

- Default to no persistent host permissions beyond extension pages.
- Use `activeTab` for one-off recording or running on the currently selected tab after a click/hotkey.
- For saved profiles, store explicit domain/path patterns and request optional host permissions only for those patterns.
- Show the exact domains a profile can read/write before enabling automation.
- Watchers may only run on hosts that have been explicitly granted for that profile.
- Block privileged and sensitive schemes: `chrome://`, `edge://`, `about:`, `file://` by default, extension pages, Chrome Web Store / Edge Add-ons pages, browser settings pages, and internal browser pages.
- Warn before enabling automation on financial, healthcare, identity, admin-console, or password-manager domains.
- Prefer narrow patterns such as `https://example.com/*` over wildcards such as `https://*/*`.

## Page read/write and automation boundaries

- Content scripts may only read DOM fields needed for the current capture, condition, or action.
- Writes/clicks/keystrokes must target selectors captured or configured in the profile; avoid arbitrary script execution.
- Cross-tab or cross-page automation must preserve an execution trace: source profile, tab ID/window ID where available, URL/domain, action, result, and redacted payload.
- High-risk actions such as form submission, purchases, deletes, account changes, sending messages, closing tabs, or navigation to non-profile domains require either:
  - an explicit per-profile permission flag, or
  - an interactive confirmation at run time.
- Automation must stop on unexpected domain changes unless the next domain is declared in the profile.

## Secret redaction and recording rules

Never record secret values by default.

Automatically redact values from:

- `<input type="password">` fields.
- Fields with names/IDs/labels/placeholders suggesting secrets: password, passcode, token, api key, secret, otp, 2fa, mfa, auth, bearer, session, cookie, credit card, cvv, ssn, private key.
- Hidden inputs and browser/autofill-managed credential fields.
- HTTP authorization headers or cookies if any network-related feature is later added.

Recording behavior:

- Store a placeholder such as `[REDACTED]`, not the original value.
- Default typing actions should support variables/prompts instead of stored secrets.
- Exports and logs must apply the same redaction rules.
- If a user explicitly chooses to store a sensitive value, require a clear warning, per-field opt-in, and a separate setting from normal recording. Prefer not implementing this in MVP.

## User consent and active indicators

- Recording requires an explicit start action and must show a visible recording state in the extension UI.
- Running automation requires an explicit start action unless a watcher is enabled for that profile.
- Watcher mode requires both:
  - a global watcher enable switch, and
  - a per-profile watcher enable switch.
- Show a persistent active indicator while recording, running, watching, or connected to an external controller.
- Provide one-click emergency stop/pause from the popup/side panel and hotkey if possible.
- Before enabling a profile, summarize: domains, permissions, watcher state, high-risk actions, and whether external control may invoke it.

## External control design

Browser extensions cannot safely expose arbitrary listening TCP ports by themselves. External control should be implemented through a separate local companion or native messaging host, with the extension remaining permission-minimized.

Required defaults:

- **Disabled by default.**
- **Bind to localhost only** (`127.0.0.1` and/or `::1`) for MVP.
- **No public exposure.** Never bind to `0.0.0.0` or a public interface by default.
- **Token authentication required** for every command.
- **Deny by default** if token, origin, host, or profile allowlist does not match.

If LAN/Tailscale control is later enabled:

- Require explicit user opt-in separate from localhost mode.
- Require a strong generated token; display it once and allow rotation/revocation.
- Require bind-address allowlist: e.g. localhost only, specific Tailscale IP, or specific LAN IP.
- Require client allowlist by IP/CIDR and/or Tailscale identity where available.
- Require CORS origin allowlist; do not use wildcard `Access-Control-Allow-Origin: *` with credentials/tokens.
- Rate-limit requests globally and per source.
- Restrict callable profiles/actions with an external-control allowlist.
- Provide a clear UI indicator when external control is enabled or connected.
- Log accepted and denied requests.

External API safety:

- Support only high-level commands such as list allowed profiles, run allowed profile, stop current run, get redacted status/logs.
- Do not expose arbitrary DOM read/write, arbitrary JavaScript execution, unrestricted URL navigation, or raw secret/log export.
- Validate all inputs, cap payload sizes, and reject unknown fields.
- Use HTTPS or a secure tunnel for non-localhost traffic where feasible; do not recommend port-forwarding to the public internet.

## Native messaging vs WebSocket companion

Preferred architecture options:

1. **Native messaging host**
   - Best for local-only integration with strong browser-mediated origin binding.
   - Requires an installed native host manifest and explicit extension ID allowlist.
   - Good default for local companion commands where no LAN listener is needed.

2. **Local WebSocket/HTTP companion**
   - Useful when other local software needs a simple API.
   - Must default to localhost, token auth, CORS allowlist, rate limits, and explicit profile allowlist.
   - LAN/Tailscale binding must be an advanced opt-in setting.

Recommendation: use native messaging for local privileged companion communication where possible. Use a WebSocket/HTTP companion only for explicit integration needs, and keep LAN/Tailscale support off by default.

## Storage, profiles, exports, and logs

- Store profiles and logs in `chrome.storage.local` by default.
- Redact sensitive values before storage.
- Keep logs bounded by size/count and provide a clear/delete control.
- Logs should include timestamps, profile ID/name, step ID/name, URL/domain, status, error messages, and redacted payloads.
- Logs must not include full page HTML, cookies, tokens, password values, or unredacted form contents.
- Export/import must validate schema and preserve redaction.
- Imports should default imported profiles to disabled until reviewed by the user.
- Consider encrypting optional sensitive local settings if a platform-appropriate mechanism exists; do not rely on `chrome.storage.local` as a secure secret vault.

## Safe defaults checklist

- [x] External control disabled by default.
- [x] Companion and Controller bind localhost by default; LAN requires explicit opt-in.
- [x] Remote Browser Agent mode requires a token of at least 24 characters and an explicit IP allowlist.
- [ ] The extension currently retains `<all_urls>` for recorder/runner coverage. This is an accepted medium limitation for the personal MVP, not a least-privilege claim.
- [x] Watcher globally disabled by default.
- [x] Sensitive Controller workflow inputs are rejected and secret-like diagnostic fields are redacted.
- [ ] Generic high-risk action classification/confirmation is not implemented. This is an accepted medium limitation; use reviewed controlled workflows only.
- [x] Active recording state and run stop control are visible in the Extension UI.
- [x] Emergency stop/cancel paths are available and terminal input cleanup releases held keys/buttons.
- [x] Arbitrary browser-internal navigation, arbitrary CDP, arbitrary JavaScript, and shell command control types are denied.
- [x] Audit and execution-event stores are bounded.

## Phase 9 managed-container security result

- Critical findings: 0 open.
- High findings: 0 open.
- Electron renderer isolation, trusted sender validation, typed IPC, pairing authority, revocation, restart replay, exactly-once terminal handling, WSS bounds, Native Messaging validation, input release, clipboard policy, managed Docker allowlisting, diagnostic redaction, release allowlists, and immutable minimum-permission workflows have focused regression coverage.
- Chromium uses the non-root user-namespace architecture with exact AppArmor transition and constrained seccomp policy. SUID is absent. GitHub run `29653528313` authoritatively reported all required sandbox layers active.
- `no-new-privileges` is not set for this container because it blocks the reviewed AppArmor profile transition on Ubuntu 24.04; this exception does not add capabilities or disable AppArmor/seccomp.
- Accepted medium limitations: broad extension host permission, no generic high-risk action classifier, unsigned development packages without external signing material, and no public-Internet deployment support.

## Phase 10 final security acceptance

- Reviewed host policy installation is persistent and independently verified by exact path, owner, mode, SHA-256, JSON parsing, AppArmor enforce state, and a disposable policy-bound container.
- Managed runtime verification confirms non-root user, bridge/private PID namespaces, bounded memory/CPU/PIDs, loopback-only control port, exact AppArmor and canonical seccomp, no Docker socket or host-home mount, no added capabilities, no privileged/unconfined mode, and no Chromium sandbox bypass.
- Negative WSS acceptance now requires rejection of missing trust, wrong TLS hostname, missing authorization, wrong credential, unpaired Agent, and revoked credential.
- The full product path and soak complete with zero credential exposures, duplicate authoritative sessions, duplicate executions, lost terminal results, or unsandboxed executions.

## Non-goals / prohibited defaults

- No public internet listener.
- No unauthenticated LAN/Tailscale API.
- No wildcard CORS with authenticated requests.
- No arbitrary remote JavaScript execution.
- No recording password/API-token values by default.
- No silent background watcher activation.
- No broad host permissions at install time.
