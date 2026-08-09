import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { controllerFiles, extensionFiles, browserAgentFiles } from '../../../scripts/release/release-files.mjs';
import { execFileP } from '../../../scripts/release/release-utils.mjs';

test('release file allowlists keep controller package scoped to runtime files', () => {
  assert(controllerFiles.includes('platform/controller-electron/src/main.js'));
  assert(controllerFiles.includes('platform/controller-electron/src/containerAdapter.js'));
  assert(controllerFiles.includes('platform/controller-electron/src/controllerHost.js'));
  assert(controllerFiles.includes('platform/controller-electron/src/runtimeProfileStore.js'));
  assert(controllerFiles.includes('platform/controller-electron/release/packagedSmoke.js'));
  assert(controllerFiles.includes('platform/controller-electron/renderer/scrollState.js'));
  assert(controllerFiles.includes('platform/controller-wss/src/wssServer.js'));
  assert(controllerFiles.includes('platform/controller-core/src/controllerCore.js'));
  assert(controllerFiles.includes('platform/controller-core/src/containerRegistry.js'));
  assert(controllerFiles.includes('platform/controller-core/src/networkConfig.js'));
  assert(controllerFiles.includes('platform/input-parser/src/inputParser.js'));
  assert(controllerFiles.includes('src/graph.js'));
  assert(controllerFiles.includes('src/shared.js'));
  assert(controllerFiles.includes('platform/diagnostics/src/redaction.js'));
  assert(controllerFiles.includes('platform/container/security/chromium-userns-seccomp.json'));
  assert(controllerFiles.includes('platform/container/security/war-browser-agent.apparmor'));
  assert(controllerFiles.every((file) => !file.includes('/test/') && !file.includes('/integration/')));
  assert(controllerFiles.every((file) => !file.startsWith('artifacts/') && !file.startsWith('docs/')));
});

test('electron builder package includes shared runtime diagnostics', () => {
  const config = fs.readFileSync(new URL('../release/electron-builder.config.cjs', import.meta.url), 'utf8');
  assert.match(config, /platform\/diagnostics\/src\/\*\*/);
  assert.match(config, /platform\/input-parser\/src\/\*\*/);
  assert.match(config, /platform\/container\/security\/\*\*/);
  assert.match(config, /src\/graph\.js/);
  assert.match(config, /src\/shared\.js/);
});

test('electron-builder externally bundles the locked ws runtime without rebuilding or silent dependency omission', async () => {
  const configPath = new URL('../release/electron-builder.config.cjs', import.meta.url);
  const configSource = fs.readFileSync(configPath, 'utf8');
  const require = createRequire(import.meta.url);
  const config = require(fileURLToPath(configPath));
  const wsManifest = JSON.parse(fs.readFileSync(path.resolve('node_modules/ws/package.json'), 'utf8'));

  assert.match(configSource, /npmRebuild\s*:\s*true/, 'electron-builder must enter its dependency lifecycle before the skip hook');
  assert.equal(typeof config.beforeBuild, 'function', 'beforeBuild must be an executable hook');
  assert.equal(await config.beforeBuild(), false, 'beforeBuild must skip app-builder-lib dependency installation');

  const wsFileSet = config.files.find((entry) => (
    entry && typeof entry === 'object' &&
    entry.from === path.resolve('node_modules/ws') &&
    entry.to === 'node_modules/ws'
  ));
  assert.ok(wsFileSet, 'the locked root node_modules/ws directory must be copied explicitly');
  assert.ok(Array.isArray(wsFileSet.filter) && wsFileSet.filter.includes('**/*'), 'the ws FileSet must have an explicit recursive filter');
  assert.ok(config.files.includes('package.json'), 'the existing package metadata pattern must remain in the allowlist');
  assert.ok(config.files.includes('platform/controller-electron/src/**/*'), 'the existing Controller runtime pattern must remain in the allowlist');
  assert.equal(config.extraMetadata?.dependencies?.ws, wsManifest.version, 'packaged ws metadata must match the installed locked version');
  assert.equal(wsManifest.version, '8.21.1', 'the packaging contract must remain pinned to ws@8.21.1');

  const runtimeDependencies = { ...wsManifest.dependencies, ...wsManifest.optionalDependencies };
  assert.deepEqual(runtimeDependencies, {}, 'ws@8.21.1 must not hide an unbundled runtime dependency');
  assert.ok(
    Object.values(wsManifest.peerDependenciesMeta ?? {}).every((metadata) => metadata?.optional === true),
    'any ws peer dependency must be explicitly optional rather than silently required'
  );
});

test('offline Controller packaging reuses only a verified, safely extracted Electron cache', () => {
  const packager = fs.readFileSync(new URL('../../../scripts/release/package-controller-electron.mjs', import.meta.url), 'utf8');
  const archiveName = 'electron-v43.1.1-win32-x64.zip';
  const archiveSha256 = 'b4e9995cd3f65785eb8818276aa9020f3165ab11da41b3c762616d4a0ad8c7ad';

  assert.match(packager, new RegExp(`['"]${archiveName}['"]`), 'the exact cached Electron archive must be pinned');
  assert.match(packager, new RegExp(`['"]${archiveSha256}['"]`), 'the official Electron archive SHA256 must be pinned');
  assert.match(packager, /lstat\s*\(/, 'the cache candidate must be inspected without following links');
  assert.match(packager, /\.isFile\s*\(\s*\)/, 'only a regular cache file may be reused');
  assert.match(packager, /\.isSymbolicLink\s*\(\s*\)/, 'symbolic-link or reparse-point cache candidates must be rejected');
  assert.match(packager, /(?:realpath|relative)\s*\(/, 'the cache path must be constrained to its owned location');
  assert.match(packager, /copyFile\s*\(/, 'the cache archive must first be copied into owned release-work staging');
  assert.match(packager, /createHash\s*\(\s*['"]sha256['"]\s*\)/, 'the owned staging copy must be SHA256 hashed');
  assert.match(packager, /digest\s*\(\s*['"]hex['"]\s*\)/, 'the staging hash must be rendered for exact comparison');
  assert.match(packager, /rmDir\s*\([\s\S]{0,280}?ensureDir\s*\(/, 'the verified Electron extraction directory must be freshly recreated');
  assert.match(packager, /(?:Expand-Archive|unzip|extract|tar)\b/i, 'the verified staging archive must be extracted before reuse');
  const stagingCopy = packager.search(/copyFile\s*\(/);
  const stagingHash = packager.search(/createHash\s*\(\s*['"]sha256['"]\s*\)/);
  const extraction = packager.search(/(?:Expand-Archive|unzip|extract|tar)\b/i);
  const electronDist = packager.indexOf('--config.electronDist=');
  assert.ok(
    stagingCopy < stagingHash && stagingHash < extraction && extraction < electronDist,
    'the cache must be copied, hashed, and extracted in that order before electron-builder can use it'
  );
  assert.doesNotMatch(
    packager,
    /localElectronVersion\?\.trim\(\)\s*===\s*rootPackage\.devDependencies\.electron[\s\S]{0,240}?args\.push\s*\(/,
    'a version-file match alone must never authorize local Electron reuse'
  );
  assert.match(
    packager,
    /if\s*\([\s\S]{0,220}?(?:sha256|checksum|digest|hash)[\s\S]{0,220}?\)\s*\{[\s\S]{0,480}?args\.push\(\s*[`'"]--config\.electronDist=\$?\{?[^\n)]*/i,
    'electron-builder must receive only a checksum-verified extracted dist; missing or mismatched cache must retain download fallback'
  );
});

test('Controller cache packaging never invokes a PATH-resolved tar.exe', () => {
  const packager = fs.readFileSync(new URL('../../../scripts/release/package-controller-electron.mjs', import.meta.url), 'utf8');

  assert.doesNotMatch(
    packager,
    /execFileP\s*\(\s*['\"]tar\.exe['\"]/,
    'cache extraction must delegate to the trusted Windows tar helper instead of resolving tar.exe through PATH'
  );
});

test('release command runner rejects command shims before a child process resolves them', async () => {
  await assert.rejects(
    () => execFileP('synthetic-release-runner.cmd', ['synthetic-marker']),
    (error) => {
      assert.equal(error?.code, 'ERR_RELEASE_COMMAND_SHIM');
      assert.equal(error?.message, 'Refusing to execute command shims; invoke a trusted Node entry point instead.');
      return true;
    }
  );
});

test('release runners invoke trusted absolute Node entry points instead of ambient command shims', () => {
  const packageController = fs.readFileSync(new URL('../../../scripts/release/package-controller-electron.mjs', import.meta.url), 'utf8');
  const releaseBundle = fs.readFileSync(new URL('../../../scripts/release/release-bundle.mjs', import.meta.url), 'utf8');
  const releaseGate = fs.readFileSync(new URL('../../../scripts/release/release-gate.mjs', import.meta.url), 'utf8');
  const releaseUtils = fs.readFileSync(new URL('../../../scripts/release/release-utils.mjs', import.meta.url), 'utf8');

  assert.match(packageController, /rootPath\(\s*['"]node_modules['"]\s*,\s*['"]electron-builder['"]\s*,\s*['"]cli\.js['"]\s*\)/);
  assert.match(packageController, /execFileP\s*\(\s*process\.execPath\s*,/);
  assert.doesNotMatch(packageController, /execFileP\s*\(\s*['"]npx(?:\.cmd)?['"]/i);

  for (const script of [
    'package-controller-electron.mjs',
    'package-browser-agent.mjs',
    'package-extension.mjs',
    'test-release-integrity.mjs',
    'test-packaged-controller.mjs'
  ]) {
    const source = script.startsWith('test-') ? releaseGate : releaseBundle;
    assert.match(source, new RegExp(`rootPath\\(\\s*['\"]scripts['\"]\\s*,\\s*['\"]release['\"]\\s*,\\s*['\"]${script}['\"]\\s*\\)`));
  }
  assert.match(releaseBundle, /execFileP\s*\(\s*process\.execPath\s*,/);
  assert.match(releaseGate, /execFileP\s*\(\s*process\.execPath\s*,/);
  assert.doesNotMatch(releaseBundle, /execFileP\s*\(\s*['"]npm(?:\.cmd)?['"]/i);
  assert.doesNotMatch(releaseGate, /execFileP\s*\(\s*['"]npm(?:\.cmd)?['"]/i);
  assert.doesNotMatch(releaseUtils, /(?:\?|=|===|!==)\s*['"]cmd\.exe['"]/i);
});

test('trusted Windows tar factory declares GLOBALROOT, never ambient SystemRoot, as its authority', () => {
  const helper = fs.readFileSync(new URL('../../../scripts/release/trusted-windows-tar.mjs', import.meta.url), 'utf8');

  assert.match(helper, /GLOBALROOT/, 'the default authority must name the OS object-manager root');
  assert.doesNotMatch(helper, /process\.env\.SystemRoot/, 'ambient SystemRoot must not choose the trusted root');
});

test('trusted Windows tar extraction starts at GLOBALROOT despite a fully spoofed process environment', async (t) => {
  const systemRootAuthority = String.raw`\\?\GLOBALROOT\SystemRoot`;
  const safeSystemRoot = String.raw`C:\Windows`;
  const safeSystem32 = path.join(safeSystemRoot, 'System32');
  const trustedTar = path.join(safeSystem32, 'tar.exe');
  const attackerSystemRoot = String.raw`C:\attacker\Windows`;
  const attackerTar = path.join(attackerSystemRoot, 'System32', 'tar.exe');
  const marker = 'synthetic-signing-marker-must-not-reach-tar';
  const spoofedProcessKeys = ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP'];
  const previousProcessEnvironment = Object.fromEntries(
    spoofedProcessKeys.map((key) => [key, process.env[key]])
  );

  for (const key of spoofedProcessKeys) process.env[key] = key === 'PATH' ? String.raw`C:\attacker\bin` : attackerSystemRoot;
  t.after(() => {
    for (const key of spoofedProcessKeys) {
      if (previousProcessEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = previousProcessEnvironment[key];
    }
  });

  const directory = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
  const file = { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
  const lookups = [];
  const fsApi = {
    async lstat(target) {
      lookups.push({ operation: 'lstat', target });
      if (target === systemRootAuthority || target === safeSystem32) return directory;
      if (target === trustedTar) return file;
      throw new Error(`untrusted filesystem lookup: ${target}`);
    },
    async realpath(target) {
      lookups.push({ operation: 'realpath', target });
      if (target === systemRootAuthority) return safeSystemRoot;
      if (target === safeSystem32 || target === trustedTar) return target;
      throw new Error(`untrusted filesystem resolution: ${target}`);
    }
  };

  const { createTrustedTarExtractor } = await import(new URL('../../../scripts/release/trusted-windows-tar.mjs', import.meta.url));
  let execCall;
  const extractTrustedTar = createTrustedTarExtractor({
    execFileP: async (filePath, args, options) => {
      execCall = { filePath, args, options };
    },
    fsApi,
    platform: 'win32',
    environment: {
      SystemRoot: attackerSystemRoot,
      WINDIR: attackerSystemRoot,
      PATH: String.raw`C:\attacker\bin`,
      TEMP: attackerSystemRoot,
      TMP: attackerSystemRoot,
      CSC_LINK: marker,
      CSC_KEY_PASSWORD: marker,
      WAR_WINDOWS_SIGN_CERT_PATH: marker,
      WAR_WINDOWS_SIGN_CERT_PASSWORD: marker,
      CERTIFICATE_PATH: marker
    }
  });

  await extractTrustedTar({ archivePath: String.raw`C:\release\electron.zip`, destinationPath: String.raw`C:\release\electron-dist` });

  assert.deepEqual(lookups.map(({ target }) => target), [
    systemRootAuthority,
    systemRootAuthority,
    safeSystem32,
    safeSystem32,
    trustedTar,
    trustedTar
  ]);
  assert.equal(execCall.filePath, trustedTar, 'tar.exe must resolve from the OS-authoritative System32');
  assert.notEqual(execCall.filePath, attackerTar, 'the attacker System32 tar.exe must never be selected');
  assert.deepEqual(execCall.args, ['-xf', String.raw`C:\release\electron.zip`, '-C', String.raw`C:\release\electron-dist`]);
  assert.deepEqual(
    execCall.options.env,
    { SystemRoot: safeSystemRoot, WINDIR: safeSystemRoot },
    'the tar child receives only its resolved Windows root, never spoofed PATH or signing data'
  );
  assert.equal(JSON.stringify(execCall.options.env).includes(marker), false);
  assert.equal(Object.hasOwn(execCall.options.env, 'PATH'), false);
});

test('electron-builder receives a child-only trusted Windows environment before it is spawned', async () => {
  const systemRootAuthority = String.raw`\\?\GLOBALROOT\SystemRoot`;
  const safeSystemRoot = String.raw`C:\Windows`;
  const nodeDirectory = String.raw`C:\Program Files\nodejs`;
  const trustedPath = [
    nodeDirectory,
    safeSystemRoot,
    path.join(safeSystemRoot, 'System32'),
    path.join(safeSystemRoot, 'System32', 'WindowsPowerShell', 'v1.0')
  ].join(';');
  const attackerDirectory = String.raw`C:\attacker\bin`;
  const signingMarker = 'synthetic-signing-marker-must-reach-electron-builder';
  const fsApi = {
    async lstat(target) {
      assert.equal(target, systemRootAuthority, 'only the OS-authoritative SystemRoot may be inspected');
      return { isDirectory: () => true, isSymbolicLink: () => false };
    },
    async realpath(target) {
      assert.equal(target, systemRootAuthority, 'only the OS-authoritative SystemRoot may be resolved');
      return safeSystemRoot;
    }
  };

  const { createTrustedWindowsReleaseEnvironment } = await import(
    new URL('../../../scripts/release/trusted-windows-release-env.mjs', import.meta.url)
  );
  const env = await createTrustedWindowsReleaseEnvironment({
    fsApi,
    platform: 'win32',
    execPath: path.join(nodeDirectory, 'node.exe'),
    environment: {
      PATH: `${attackerDirectory};${nodeDirectory}`,
      Path: attackerDirectory,
      SystemRoot: String.raw`C:\attacker\Windows`,
      WINDIR: String.raw`C:\attacker\Windows`,
      ComSpec: path.join(attackerDirectory, 'cmd.exe'),
      PATHEXT: '.EVIL;.CMD',
      NODE_OPTIONS: '--require C:\\attacker\\hook.cjs',
      node_path: attackerDirectory,
      CSC_LINK: signingMarker,
      ELECTRON_BUILDER_CACHE: String.raw`C:\cache\electron-builder`
    }
  });
  assert.equal(env.PATH, trustedPath);
  assert.equal(
    Object.keys(env).filter((key) => key.toLowerCase() === 'path').length,
    1,
    'the child environment must have exactly one canonical PATH key'
  );
  assert.equal(env.PATH.includes(attackerDirectory), false);
  assert.equal(env.SystemRoot, safeSystemRoot);
  assert.equal(env.WINDIR, safeSystemRoot);
  assert.equal(env.ComSpec, path.join(safeSystemRoot, 'System32', 'cmd.exe'));
  assert.equal(env.PATHEXT, '.COM;.EXE;.BAT;.CMD');
  assert.equal(Object.keys(env).some((key) => key.toLowerCase() === 'node_options'), false);
  assert.equal(Object.keys(env).some((key) => key.toLowerCase() === 'node_path'), false);
  assert.equal(env.CSC_LINK, signingMarker, 'builder signing inputs must be preserved');
  assert.equal(env.ELECTRON_BUILDER_CACHE, String.raw`C:\cache\electron-builder`, 'builder cache inputs must be preserved');

  const packageController = fs.readFileSync(new URL('../../../scripts/release/package-controller-electron.mjs', import.meta.url), 'utf8');
  const environmentCreation = packageController.search(/await\s+createTrustedWindowsReleaseEnvironment\s*\(/);
  const builderSpawn = packageController.search(/await\s+execFileP\s*\(\s*process\.execPath\s*,/);
  assert.ok(environmentCreation >= 0, 'package-controller must create the trusted builder child environment');
  assert.ok(builderSpawn > environmentCreation, 'package-controller must await the trusted environment before spawning electron-builder');
  assert.match(
    packageController,
    /await\s+execFileP\s*\(\s*process\.execPath\s*,[\s\S]{0,120}?env\s*:\s*trustedWindowsReleaseEnv/s,
    'package-controller must pass the awaited trusted environment to electron-builder'
  );
});

test('release file allowlists separate sidecar extension and browser agent packages', () => {
  assert(extensionFiles.includes('manifest.json'));
  assert(extensionFiles.includes('src/service-worker.js'));
  assert(extensionFiles.includes('ui/sidepanel.html'));
  assert(extensionFiles.every((file) => !file.startsWith('platform/browser-agent/')));
  assert(browserAgentFiles.includes('platform/browser-agent/src/agent.js'));
  assert(browserAgentFiles.includes('native-host/install.js'));
  assert(browserAgentFiles.includes('platform/protocol/src/schemaValidator.js'));
  assert(browserAgentFiles.includes('platform/diagnostics/src/redaction.js'));
  assert(browserAgentFiles.includes('platform/container/security/chromium-userns-seccomp.json'));
  assert(browserAgentFiles.includes('platform/workflow-core/src/workflowMetadata.js'));
  assert(browserAgentFiles.includes('platform/browser-agent/src/terminalOutbox.js'));
  assert(browserAgentFiles.every((file) => !file.includes(`${path.sep}test${path.sep}`)));
});

test('Browser Agent Docker stages pin the base, CloakBrowser, and sensitive xclip helper', () => {
  const dockerfile = fs.readFileSync(new URL('../../browser-agent/Dockerfile', import.meta.url), 'utf8');
  const fromLines = dockerfile.split(/\r?\n/).filter((line) => line.startsWith('FROM '));
  assert.equal(fromLines.length, 4);
  assert.match(fromLines[0], /^FROM node:22-bookworm-slim@sha256:[a-f0-9]{64} AS native-build$/);
  assert.match(fromLines[1], /^FROM node:22-bookworm-slim@sha256:[a-f0-9]{64} AS xclip-sensitive-build$/);
  assert.match(fromLines[2], /^FROM node:22-bookworm-slim@sha256:[a-f0-9]{64} AS cloakbrowser-build$/);
  assert.match(fromLines[3], /^FROM node:22-bookworm-slim@sha256:[a-f0-9]{64}$/);
  assert.equal(new Set(fromLines.map((line) => line.match(/sha256:[a-f0-9]{64}/)[0])).size, 1);

  assert.match(dockerfile, /ARG XCLIP_COMMIT=2c3b811002b35d3be7f39cc1145dd06bdb32e31c/);
  assert.match(dockerfile, /ARG XCLIP_ARCHIVE_SHA256=2bb193f5ac15872bc1b2579643bebf6303804b98e7b6bcc55ff2be9921843a4a/);
  assert.match(dockerfile, /https:\/\/github\.com\/astrand\/xclip\/archive\/\$\{XCLIP_COMMIT\}\.tar\.gz/);
  assert.match(dockerfile, /\$\{XCLIP_ARCHIVE_SHA256\}\s+\/tmp\/xclip\.tar\.gz" \| sha256sum --check --status/);
  assert.match(dockerfile, /autoreconf --install --force/);
  assert.match(dockerfile, /\.\/configure --prefix=\/usr\/local/);
  assert.match(dockerfile, /strip xclip/);
  assert.match(dockerfile, /\.\/xclip -help 2>&1 \| grep --quiet -- '-sensitive'/);
  assert.match(dockerfile, /COPY --from=xclip-sensitive-build \/build\/xclip\/xclip \/usr\/local\/bin\/war-xclip-sensitive/);
  assert.match(dockerfile, /test -x \/usr\/local\/bin\/war-xclip-sensitive/);
  assert.match(dockerfile, /ARG XCLIP_LICENSE=GPL-2\.0-or-later/);
  assert.match(dockerfile, /com\.web-action-recorder\.xclip-license="\$\{XCLIP_LICENSE\}"/);
  assert.match(dockerfile, /COPY --from=xclip-sensitive-build \/build\/xclip\/COPYING \/usr\/share\/licenses\/war-xclip-sensitive\/LICENSE/);
  assert.match(dockerfile, /\/usr\/share\/doc\/war-xclip-sensitive\/NOTICE/);
  assert.match(dockerfile, /\/usr\/share\/doc\/war-xclip-sensitive\/SOURCE\.json/);
  assert.match(dockerfile, /\/usr\/share\/doc\/war-xclip-sensitive\/SBOM\.spdx\.json/);

  assert.match(dockerfile, /ARG CLOAKBROWSER_VERSION=146\.0\.7680\.177\.5/);
  assert.match(dockerfile, /ARG CLOAKBROWSER_ARCHIVE_SHA256=4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e/);
  assert.match(dockerfile, /verifySignature\(manifest\.manifestBytes, manifest\.sigBytes\)/);
  assert.match(dockerfile, /COPY --from=cloakbrowser-build \/opt\/war\/cloakbrowser \/opt\/war\/cloakbrowser/);
});

test('Browser Agent release package carries exact xclip GPL license, source provenance, SBOM, and notice', () => {
  for (const file of [
    'platform/browser-agent/THIRD_PARTY_NOTICES.md',
    'platform/browser-agent/SBOM.spdx.json',
  ]) {
    assert.ok(browserAgentFiles.includes(file), `release allowlist must include ${file}`);
  }
  const notice = fs.readFileSync(path.resolve('platform/browser-agent/THIRD_PARTY_NOTICES.md'), 'utf8');
  const sbom = JSON.parse(fs.readFileSync(path.resolve('platform/browser-agent/SBOM.spdx.json'), 'utf8'));
  assert.match(notice, /xclip/i);
  assert.match(notice, /GPL-2\.0-or-later/);
  assert.match(notice, /2c3b811002b35d3be7f39cc1145dd06bdb32e31c/);
  assert.match(notice, /2bb193f5ac15872bc1b2579643bebf6303804b98e7b6bcc55ff2be9921843a4a/);
  assert.equal(sbom.spdxVersion, 'SPDX-2.3');
  const xclip = sbom.packages?.find((entry) => entry.name === 'xclip-sensitive');
  assert.equal(xclip?.licenseConcluded, 'GPL-2.0-or-later');
  assert.equal(xclip?.downloadLocation, 'https://github.com/astrand/xclip/archive/2c3b811002b35d3be7f39cc1145dd06bdb32e31c.tar.gz');
  assert.equal(xclip?.checksums?.some((entry) => entry.algorithm === 'SHA256' && entry.checksumValue === '2bb193f5ac15872bc1b2579643bebf6303804b98e7b6bcc55ff2be9921843a4a'), true);
});
