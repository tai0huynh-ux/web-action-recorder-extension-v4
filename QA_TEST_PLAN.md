# QA Test Plan — Web Action Recorder/Runner Extension

## Scope
Validate the Chrome/Edge MV3 extension can record, edit, run, export/import, and safely control web workflows. Mark each result as Pass/Fail/Blocked with browser, OS, extension build, and repro notes.

## Test Environment
- Chrome stable and Edge stable, fresh profile and existing profile.
- CloakBrowser/noVNC for final QA after appdev implementation is ready.
- Local static test site with pages for buttons, text inputs, selects, navigation, tabs, iframes if supported, and fake sensitive fields.
- At least two domains/hosts: one matching `*abcxyz*`, one non-matching.
- Network offline/slow mode for resilience checks.

## QA Execution Rule After Appdev
- QA must test every visible button/control/function one by one in CloakBrowser/noVNC before reporting to Tài.
- If any case fails, record a bug for appdev with steps, expected/actual result, screenshot/log when useful, severity, and blocker status.
- Appdev fixes must be re-tested by QA; repeat bug/fix/retest until pass or a real blocker is documented.
- Final QA output must explicitly state: Pass / Fail / Blocker, tested build/commit, browser/profile, key evidence, open bugs, and what was not tested.

## CloakBrowser/noVNC E2E Checklist
Run this checklist on the implemented extension, not just code review:
- [ ] Open CloakBrowser/noVNC and confirm browser is controllable.
- [ ] Install unpacked extension from `web-action-recorder-extension/`.
- [ ] Open extension UI/popup/side panel/options and verify no console/runtime errors.
- [ ] Click each top-level navigation/tab/control: profiles, editor, recorder, condition library, logs, import/export, settings/security.
- [ ] Start recording; click a test-page button; stop recording; verify card appears.
- [ ] Start recording; type in a test input; stop; verify type/input-fill action appears and sensitive fields are redacted.
- [ ] Use **Add Action** control; create click, input fill, wait/delay, navigate/open-tab where supported.
- [ ] Use **Add Condition** control; create page text, field value, and domain condition.
- [ ] Test domain pattern condition `*abcxyz*` on matching and non-matching pages.
- [ ] Edit action card name/body; save; reload UI; verify persistence.
- [ ] Edit delay arrows between cards; run workflow; verify delay is honored.
- [ ] Use condition capture button; verify condition is inserted/saved.
- [ ] Use capture hotkey; verify same behavior and no crash on unsupported page.
- [ ] Build if/else workflow and verify true/false branches.
- [ ] Build multi-branch workflow and verify branch selection/default branch.
- [ ] Run workflow end-to-end on same page.
- [ ] Run workflow across navigation and/or tabs.
- [ ] Save profile; switch/load profile; verify workflow data persists.
- [ ] Export profile/all data; import into clean profile/session; verify workflow runs.
- [ ] Open logs; verify step results, branch decision, errors, and redaction.
- [ ] Clear/export logs if controls exist.
- [ ] Verify watcher/combo controls are clearly MVP-disabled or future-labeled if not implemented.
- [ ] Verify external control is disabled or localhost-only by default, requires token when enabled, and shows visible warning/status.

## Button / Control Checklist
For every visible control, perform click/use + expected result + error-state check:
- [ ] Extension icon / open UI.
- [ ] Start Recording.
- [ ] Stop/Pause Recording if present.
- [ ] Add Action.
- [ ] Add Condition.
- [ ] Capture Current Action/Condition button.
- [ ] Save Profile.
- [ ] Load/Switch Profile.
- [ ] New/Duplicate/Delete Profile if present.
- [ ] Run Workflow.
- [ ] Stop/Cancel Run.
- [ ] Add/Edit/Delete card.
- [ ] Reorder card or connector controls.
- [ ] Delay arrow edit control.
- [ ] Branch add/remove/default controls.
- [ ] Import.
- [ ] Export.
- [ ] Logs open/refresh/clear/export controls.
- [ ] Settings toggles: watcher, combo, external control, redaction, permissions/security.
- [ ] Hotkey command.

## Manual Test Matrix

### 1. Install & Permissions
- Load unpacked extension from `web-action-recorder-extension/` via `chrome://extensions` / `edge://extensions` developer mode.
- Confirm manifest loads without errors; service worker/content scripts start.
- Verify requested permissions are minimal, understandable, and match features used.
- Test first-run/onboarding state: no automation active by default, clear empty profile state.
- Disable/re-enable, reload extension, restart browser: stored profiles/log settings persist.

### 2. Record Basic Actions
- Start recording, click a visible button, stop recording; verify a named rectangular card is created with selector/action details.
- Record typing into a normal input; verify value capture behavior matches settings.
- Record typing into password/secret-like fields; verify values are not stored or are redacted by default.
- Rename action card; edit selector/value; save and reload UI.
- Re-run recorded click/type workflow on the same page and verify DOM result.

### 3. Capture Conditions: Hotkey & Button
- Use UI button to capture current URL/domain/text/selector/input-value condition.
- Use configured hotkey to capture the same condition from the active tab.
- Verify captured condition appears in reusable history/library and can be inserted into a profile.
- Verify duplicate captures are handled cleanly.
- Negative: hotkey when no supported tab is active should show a safe error, not crash.

### 4. Workflow Editor UX
- Create workflow with multiple rectangular cards: click, type/input fill, wait, condition, navigate.
- Verify card top shows user-defined action name and body shows action details.
- Verify arrows connect steps in execution order.
- Edit arrow delay labels; run workflow and confirm delay is honored within tolerance.
- Add/edit/delete/reorder actions; verify arrows and branch targets remain valid.
- Save, close, reopen editor; layout and workflow data persist.

### 5. If/Else and Multi-Branch Logic
- Create condition: if page text exists then click A else click B; verify both paths using test pages.
- Create domain condition with pattern `*abcxyz*`; verify it matches URLs containing `abcxyz` and rejects similar non-matches.
- Create multi-branch condition: domain/text/input value routes to 3+ branches plus default branch.
- Verify branch execution logs show evaluated source, operator, redacted expected/actual where needed, and chosen branch.
- Verify invalid branch targets are blocked with validation errors before run.

### 6. Input Fill Actions
- Add input-fill action manually using selector from condition/action target picker.
- Test fill into text, textarea, search, email, number, select, checkbox/radio where supported.
- Verify events are fired (`input`, `change`, keyboard if needed) so reactive pages update.
- Verify masked/sensitive inputs require explicit opt-in or do not store raw values.

### 7. Run Across Navigation and Tabs
- Workflow: click link/navigate to page 2, wait for load/selector, continue actions.
- Workflow: open new tab, switch tab, act, return/close tab if supported.
- Verify runner survives URL changes, redirects, reloads, and content-script reinjection.
- Verify run can be cancelled mid-navigation and leaves clear status.
- Negative: target tab closed during run; expect controlled failure and log entry.

### 8. Profiles, Combos, Watcher
**MVP**
- Create multiple profiles; run selected profile on demand.
- Profile enabled/disabled flag respected.
- Export/import profiles individually or all together.

**Future / advanced acceptance when implemented**
- Combo runner executes profiles sequentially with configured delay and `stopOnError` behavior.
- Watcher global enable + profile-level watcher enable both required before automatic runs.
- Watcher visibly indicates active automation and records trigger reason.
- Watcher does not run on excluded domains or disabled profiles.

### 9. Export / Import
- Export JSON for profile library; validate schema includes version and no raw secrets by default.
- Import same JSON into fresh browser profile; workflows run correctly.
- Import duplicate profile IDs/names; verify conflict handling.
- Import malformed/older/newer-version JSON; verify safe validation error or migration.
- Verify imported workflows cannot silently enable watcher/external control if defaults prohibit it.

### 10. Logs, Errors, and Redaction
- Confirm logs show start/end, step status, selected branch, timing, errors, and cancellation.
- Passwords, tokens, cookies, authorization headers, and secret-like input values are redacted.
- Verify log clear/export behavior.
- Run failures: missing selector, timeout, permission denied, navigation error; each gives actionable message.
- Check browser console/service worker console for unhandled exceptions.

### 11. External Control Security Defaults
- Fresh install: external control disabled or localhost-only; no LAN/Tailscale/public bind by default.
- Token auth required for any external command path.
- LAN/Tailscale bind requires explicit setting plus token plus origin/host allowlist.
- Unauthorized/missing-token requests are rejected and logged without sensitive data.
- External API cannot enable watcher, run destructive profiles, import profiles, or expose logs unless explicitly permitted.
- Confirm UI clearly displays when external control is enabled.

## Regression / Edge Cases
- Extension reload during recording/running.
- Browser restart with active/incomplete run.
- Pages with dynamic DOM, shadow DOM, same-origin/cross-origin iframes as supported.
- Restricted pages (`chrome://`, Web Store, PDF viewer) fail gracefully.
- Very long workflows, many profiles, large logs: UI remains responsive.

## Automation Ideas
- Unit tests for data model validation, wildcard domain matcher (`*abcxyz*`), branch routing, redaction, import/export schema, delay parsing.
- Playwright/Puppeteer extension tests: load unpacked extension, drive popup/side panel/options page, interact with local fixture pages, verify storage/logs.
- Mock content-script tests in jsdom for selector generation, input filling, DOM event dispatch, condition evaluation.
- Integration test server with routes for navigation, redirects, delayed content, multi-tab links, and fake sensitive fields.
- Snapshot tests for workflow editor cards/arrows/branch rendering.
- Security tests for external companion/API: default bind, token rejection, allowlist enforcement, no secret leakage in responses/logs.
- CI smoke: lint/build/manifest validation, package extension, run core workflow record/import/run tests in headless Chromium where supported.

## MVP Exit Criteria
- Install unpacked in Chrome and Edge without manifest/runtime errors.
- Record click/type and capture condition via button and hotkey.
- Editor supports named cards, details, arrows, editable delays, if/else, and domain pattern `*abcxyz*`.
- Run basic workflow across at least one navigation; failures are logged clearly.
- Multiple profiles, export/import, logs with redaction work.
- External control defaults are safe: no public exposure, token required when enabled.
