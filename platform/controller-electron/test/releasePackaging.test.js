import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { controllerFiles, extensionFiles, browserAgentFiles } from '../../../scripts/release/release-files.mjs';

test('release file allowlists keep controller package scoped to runtime files', () => {
  assert(controllerFiles.includes('platform/controller-electron/src/main.js'));
  assert(controllerFiles.includes('platform/controller-electron/src/containerAdapter.js'));
  assert(controllerFiles.includes('platform/controller-electron/release/packagedSmoke.js'));
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

test('Browser Agent Docker stages use an immutable multi-architecture base image digest', () => {
  const dockerfile = fs.readFileSync(new URL('../../browser-agent/Dockerfile', import.meta.url), 'utf8');
  const fromLines = dockerfile.split(/\r?\n/).filter((line) => line.startsWith('FROM '));
  assert.equal(fromLines.length, 2);
  assert(fromLines.every((line) => /^FROM node:22-bookworm-slim@sha256:[a-f0-9]{64}(?: AS native-build)?$/.test(line)));
  assert.equal(new Set(fromLines.map((line) => line.match(/sha256:[a-f0-9]{64}/)[0])).size, 1);
});
