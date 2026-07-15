# Phase 2 Gate Research

Accessed: 2026-07-15

## Playwright Actions And Cancellation

Question: can Playwright locator actions be relied on for `AbortSignal` cancellation?

Sources:

- https://playwright.dev/docs/api/class-locator
- https://playwright.dev/docs/input

Relevant version: repo pins `playwright-core` `^1.54.1`.

Conclusion: official locator/action docs describe actionability checks and per-action timeout behavior. They do not document an `AbortSignal` option for locator actions. Phase 2 should use bounded Playwright timeouts plus an operation registry/emergency stop path rather than assuming locator-level abort support.

Risk: an in-flight Playwright call may run until its timeout if the action itself cannot be interrupted.

Confirmation: unit tests cover emergency stop state; real cancellation evidence still requires integration tests with delayed selectors/actions.

Decision: do not pass undocumented `AbortSignal` into locator options as a gate claim.

## Chrome Extension MV3 Lifecycle

Question: what lifecycle assumptions are safe for the extension service worker?

Sources:

- https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- https://chromium.googlesource.com/chromium/src/+/refs/tags/129.0.6668.7/extensions/browser/extension_service_workers.md

Conclusion: extension service workers are event-driven and may be stopped/restarted by Chrome. Browser Agent tests must tolerate dormant workers and verify extension status through persistent context and extension pages when needed.

Risk: tests that assume a continuously alive background worker can be flaky.

Confirmation: existing browser-agent unit coverage includes extension detection when the service worker is asleep.

Decision: keep service-worker dormancy as an explicit lifecycle test target.

## X.Org XTest Backend

Question: should Phase 2 replace per-command `xdotool` with a persistent helper?

Sources:

- https://www.x.org/releases/current/doc/man/man3/XTestQueryExtension.3.xhtml
- https://xorg.freedesktop.org/releases/X11R7.7/doc/xextproto/xtest.html
- https://www.x.org/guide/xlib-and-xcb/

Conclusion: XTest provides fake motion, button, and key events. Xlib queues requests and flushes to the X server, so a persistent process can reuse one Display connection and avoid process-spawn overhead from `xdotool`.

Risk: XTest is lexical input injection; synchronization with page effects still belongs in Browser Agent tests.

Confirmation: native helper now uses `XTestQueryExtension`, `XTestFakeMotionEvent`, `XTestFakeButtonEvent`, `XTestFakeKeyEvent`, and a persistent Unix socket.

Decision: default to a persistent C helper using Xlib/XTest; keep `xdotool` only behind `WAR_X11_BACKEND=xdotool` as an explicit diagnostic fallback.

## Node Unix Socket IPC

Question: is Node's built-in IPC enough for the helper client?

Source:

- https://nodejs.org/api/net.html

Conclusion: `node:net` supports Unix domain sockets on Unix systems. A line-framed JSON protocol is sufficient if frame length is bounded and pending requests are matched by ID.

Risk: malformed or oversized responses must not leave pending commands hanging forever.

Confirmation: `X11InputClient` enforces max request line length, command timeout, reconnect limit, and destroys the socket on oversized responses.

Decision: use `node:net` with NDJSON and typed command wrappers.

## Node Child Process Lifecycle

Question: should raw input continue to spawn `xdotool`?

Source:

- https://nodejs.org/api/child_process.html

Conclusion: child processes are a stable API, but per-command process creation adds latency and cancellation complexity. It also leaves a larger surface than a typed in-process protocol.

Risk: fallback still needs typed argument arrays and must not be used for performance gate claims.

Confirmation: `xdotool` fallback remains explicit only and is not installed in the default runtime image.

Decision: persistent helper is production default.

## Docker Runtime

Question: how should helper lifecycle fit the container?

Sources:

- https://docs.docker.com/engine/containers/multi-service_container/
- https://docs.docker.com/reference/dockerfile/

Conclusion: the container can start Xvfb, the helper, and Node under `dumb-init` with explicit trap cleanup. Runtime remains non-root and no extra network service is exposed.

Risk: `/run/war` ownership/mode must be fixed in image and verified by helper.

Confirmation: Dockerfile creates `/run/war` owner `war`, mode `0700`; helper creates/refuses unsafe socket paths and uses socket mode `0600`.

Decision: compile helper in a build stage and copy only the binary plus runtime X11 libraries into the final image.
