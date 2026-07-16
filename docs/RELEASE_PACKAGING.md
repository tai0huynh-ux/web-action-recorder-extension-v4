# Release Packaging

## Components

The release bundle is explicit and local-only:

- Electron Controller Windows NSIS installer.
- Electron Controller Windows portable executable.
- Electron Controller `win-unpacked` package for smoke testing.
- Browser Agent ZIP sidecar.
- MV3 Extension ZIP with `manifest.json` at archive root.
- Native Host JS runtime and install/uninstall helpers inside the Browser Agent sidecar.
- `release-manifest.json`.
- `SHA256SUMS.txt`.

Generated release artifacts are written under ignored `dist/release/`.

## Commands

```powershell
npm.cmd run package:controller-electron
npm.cmd run dist:controller-electron
npm.cmd run package:browser-agent
npm.cmd run package:extension
npm.cmd run release:bundle

npm.cmd run test:release:integrity
npm.cmd run test:controller-electron:packaged
npm.cmd run test:release:gate
```

`release:bundle` builds all release components and writes the manifest and hashes. `test:release:gate` expects artifacts to exist and verifies integrity plus packaged Controller launch/install/uninstall smoke.

## Signing Policy

Unsigned development packages are always supported:

```powershell
$env:WAR_RELEASE_CHANNEL="development"
npm.cmd run release:bundle
```

The release manifest records `signed=false` when no certificate is supplied. This is acceptable for local development packages only and must not be claimed as a production-signed release.

Production signing is enabled only when real signing material is supplied by environment or secure OS tooling. Supported variables:

```powershell
$env:WAR_WINDOWS_SIGN_CERT_PATH="C:\secure\certificate.pfx"
$env:WAR_WINDOWS_SIGN_CERT_PASSWORD="<secret>"
$env:WAR_WINDOWS_SIGN_PUBLISHER="<certificate subject>"
```

The scripts map these to Electron Builder-compatible signing variables. Do not commit certificates, passwords, base64 certificate data, signing tokens, or private keys.

After signing, release manifest generation verifies Windows executable signatures with `Get-AuthenticodeSignature`.

## Integrity

`release-manifest.json` records:

- schema version;
- product version;
- git commit;
- UTC build timestamp;
- release channel;
- operating system and architecture;
- Electron and Node versions;
- artifact names, sizes, and SHA-256 hashes;
- signing and signature status;
- known limitations.

`SHA256SUMS.txt` records every release artifact hash. `test:release:integrity` verifies all hashes, proves tamper detection with a modified temporary copy, and scans text-like release files for private keys, credentials, state files, developer paths, and certificate material.

## Packaged Controller Gate

`test:controller-electron:packaged` launches the packaged executable, not the source Electron CLI. It uses temporary state and generated local TLS files, then verifies:

- `war-controller://app/` loads;
- preload API exists and remains typed/frozen;
- all seven views open;
- renderer labels are visible;
- sandbox, context isolation, disabled Node integration, web security, and webview denial remain active;
- Controller state is outside ASAR;
- WSS starts on loopback TLS and reports the actual bound port;
- natural shutdown completes;
- NSIS installer installs to a temporary test location;
- installed executable passes the same smoke;
- uninstaller removes the installed executable.

## Browser Agent And Native Host

The Browser Agent sidecar is separate from the Controller installer. It includes startup documentation and the Native Host JS runtime. Runtime configuration must come from environment or external config; no credentials, TLS private keys, state files, or generated shim executables are bundled.

On Windows, Native Host install/uninstall uses the browser-specific HKCU Native Messaging registry key and removes only the key for this host name.

## Known Limitations

- Auto-update is not implemented in this milestone.
- Production Authenticode signing requires external certificate material.
- The Browser Agent container image build remains separate from the Windows release bundle.
- Real-world Google acceptance can be blocked by CAPTCHA, consent, or network policy; use a controlled local fallback when that happens.
