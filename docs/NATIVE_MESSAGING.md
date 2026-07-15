# Native Messaging

## Overview

The Extension connects to a small Native Host with `chrome.runtime.connectNative()`. The Native Host forwards Protocol v2 NativeBridgeEnvelope messages to the Browser Agent over a private local socket.

## Manifest Installation

Set these variables before install:

```sh
WAR_EXTENSION_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
WAR_NATIVE_HOST_NAME=com.web_action_recorder.native_bridge
WAR_NATIVE_HOST_PATH=/opt/war/web-action-recorder-extension-v4/native-host/host.js
```

Install for the current user:

```sh
node native-host/install.js --browser chrome --scope user
node native-host/install.js --browser chromium --scope user
```

Uninstall:

```sh
node native-host/install.js --browser chrome --scope user --uninstall
```

The installer writes atomically and removes only manifests whose `name` matches the project host name.

## Browser Paths

User manifest paths:

- Google Chrome: `~/.config/google-chrome/NativeMessagingHosts/<name>.json`
- Chromium: `~/.config/chromium/NativeMessagingHosts/<name>.json`

System paths are supported only when `--scope system` is explicitly selected.

## Framing

Chrome Native Messaging frames use a 4-byte unsigned little-endian payload length followed by UTF-8 JSON. The host rejects zero-length frames, oversized frames, invalid JSON, and invalid envelopes without crashing.

The Agent socket uses newline-delimited JSON. This keeps Chrome binary framing isolated to the Native Host.

## Agent Socket Configuration

Relevant variables:

- `WAR_AGENT_SOCKET_PATH`
- `WAR_AGENT_SOCKET_MAX_PAYLOAD_BYTES`
- `WAR_AGENT_SOCKET_IDLE_TIMEOUT_MS`
- `WAR_AGENT_SOCKET_REQUEST_TIMEOUT_MS`
- `WAR_AGENT_SOCKET_MAX_CONNECTIONS`
- `WAR_WORKFLOW_REGISTRY_MAX_COUNT`
- `WAR_WORKFLOW_REGISTRY_MAX_PAYLOAD_BYTES`

No public TCP listener is added for Native Bridge.

## Local Development

Keep the Browser Agent running, install the manifest for your Extension ID, then enable `nativeBridgeEnabled` in Extension settings storage. Local profile saves continue to work when the Agent is offline; bridge sync is marked pending.

## Troubleshooting

- `Specified native messaging host not found`: verify manifest path and `WAR_NATIVE_HOST_NAME`.
- `Access to the specified native messaging host is forbidden`: verify `allowed_origins` contains the active Extension ID.
- `Agent socket request timed out`: verify Browser Agent is running and `WAR_AGENT_SOCKET_PATH` matches the host environment.
- `invalid_envelope`: verify `protocolVersion` is `war-control.v2` and mutating messages include `deadline`.

## Security Limitations

Do not send screenshots, video, audio, large files, tokens, typed credentials, or arbitrary JavaScript through Native Messaging. The bridge is for control, workflow sync, health, and job/event messages only.
