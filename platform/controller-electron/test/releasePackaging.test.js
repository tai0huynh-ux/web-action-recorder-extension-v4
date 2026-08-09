import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { controllerFiles, extensionFiles, browserAgentFiles } from '../../../scripts/release/release-files.mjs';

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
