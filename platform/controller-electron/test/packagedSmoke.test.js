import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { maybeRunPackagedSmoke } from '../release/packagedSmoke.js';

test('packaged smoke waits for renderer protocol URL before asserting process state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'war-packaged-smoke-test-'));
  const output = path.join(root, 'smoke.json');
  const previousOutput = process.env.WAR_CONTROLLER_PACKAGED_SMOKE_OUTPUT;
  const previousWss = process.env.WAR_CONTROLLER_WSS_ENABLED;
  process.env.WAR_CONTROLLER_PACKAGED_SMOKE_OUTPUT = output;
  process.env.WAR_CONTROLLER_WSS_ENABLED = '1';

  let getUrlCalls = 0;
  const runtime = {
    config: { storePath: path.join(root, 'state', 'controller.json'), dataPath: path.join(root, 'state') },
    application: { getRuntimeStatus: () => ({ data: { enabled: true, port: 18765, status: 'online', bindHost: '127.0.0.1', storeStatus: 'ready' } }) },
    mainWindow: {
      webContents: {
        getURL: () => {
          getUrlCalls += 1;
          return getUrlCalls > 1 ? 'war-controller://app/' : '';
        },
        getLastWebPreferences: () => ({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false }),
        executeJavaScript: async (source) => {
          if (source.includes('window.warController.groups.create')) {
            await fs.mkdir(path.dirname(runtime.config.storePath), { recursive: true });
            await fs.writeFile(runtime.config.storePath, '{}\n');
            return undefined;
          }
          return {
            hasApi: true,
            apiKeys: ['groups'],
            text: 'Overview Devices Pairing Groups Workflows Jobs Diagnostics',
          };
        },
      },
    },
    shutdown: async () => {},
  };
  const app = {
    isPackaged: true,
    getAppPath: () => path.join(root, 'app.asar'),
    getPath: () => path.join(root, 'userData'),
    quit: () => {},
  };

  try {
    await maybeRunPackagedSmoke({ app, runtime });
    const smoke = JSON.parse(await fs.readFile(output, 'utf8'));
    assert.equal(smoke.results[0].name, 'packaged process and protocol');
    assert.equal(smoke.results[0].pass, true);
    assert.equal(smoke.results[0].data.url, 'war-controller://app/');
    assert.equal(getUrlCalls >= 2, true);
  } finally {
    if (previousOutput === undefined) delete process.env.WAR_CONTROLLER_PACKAGED_SMOKE_OUTPUT;
    else process.env.WAR_CONTROLLER_PACKAGED_SMOKE_OUTPUT = previousOutput;
    if (previousWss === undefined) delete process.env.WAR_CONTROLLER_WSS_ENABLED;
    else process.env.WAR_CONTROLLER_WSS_ENABLED = previousWss;
    process.exitCode = undefined;
    await fs.rm(root, { recursive: true, force: true });
  }
});
