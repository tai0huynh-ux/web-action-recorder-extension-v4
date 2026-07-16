import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { controllerFiles, extensionFiles, browserAgentFiles } from '../../../scripts/release/release-files.mjs';

test('release file allowlists keep controller package scoped to runtime files', () => {
  assert(controllerFiles.includes('platform/controller-electron/src/main.js'));
  assert(controllerFiles.includes('platform/controller-electron/release/packagedSmoke.js'));
  assert(controllerFiles.includes('platform/controller-wss/src/wssServer.js'));
  assert(controllerFiles.includes('platform/controller-core/src/controllerCore.js'));
  assert(controllerFiles.every((file) => !file.includes('/test/') && !file.includes('/integration/')));
  assert(controllerFiles.every((file) => !file.startsWith('artifacts/') && !file.startsWith('docs/')));
});

test('release file allowlists separate sidecar extension and browser agent packages', () => {
  assert(extensionFiles.includes('manifest.json'));
  assert(extensionFiles.includes('src/service-worker.js'));
  assert(extensionFiles.includes('ui/sidepanel.html'));
  assert(extensionFiles.every((file) => !file.startsWith('platform/browser-agent/')));
  assert(browserAgentFiles.includes('platform/browser-agent/src/agent.js'));
  assert(browserAgentFiles.includes('native-host/install.js'));
  assert(browserAgentFiles.includes('platform/protocol/src/schemaValidator.js'));
  assert(browserAgentFiles.every((file) => !file.includes(`${path.sep}test${path.sep}`)));
});
