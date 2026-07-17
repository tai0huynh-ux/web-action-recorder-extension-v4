import fs from 'node:fs';
import path from 'node:path';

const VIEW_LABELS = ['Workspace', 'Tổng quan', 'Thiết bị', 'Ghép nối', 'Nhóm', 'Quy trình', 'Tác vụ', 'Chẩn đoán'];

export async function maybeRunPackagedSmoke({ app, runtime }) {
  const outputPath = process.env.WAR_CONTROLLER_PACKAGED_SMOKE_OUTPUT;
  if (!outputPath) return;
  const results = [];
  let failed = false;

  async function run(name, fn) {
    const start = Date.now();
    try {
      const data = await fn();
      results.push({ name, pass: true, durationMs: Date.now() - start, data });
      return data;
    } catch (error) {
      failed = true;
      results.push({ name, pass: false, durationMs: Date.now() - start, error: String(error?.message || error) });
      throw error;
    }
  }

  try {
    await run('packaged process and protocol', async () => {
      const url = await waitForRendererUrl(runtime.mainWindow?.webContents);
      assert(url.startsWith('war-controller://app/'), 'packaged renderer did not load war-controller://app/');
      assert(app.isPackaged === true, 'app is not running as packaged executable');
      return { url, appPath: redactPath(app.getAppPath()), userDataBase: path.basename(app.getPath('userData')) };
    });

    await run('packaged window security', async () => {
      const prefs = runtime.mainWindow.webContents.getLastWebPreferences();
      assert(prefs.sandbox === true, 'sandbox disabled');
      assert(prefs.contextIsolation === true, 'contextIsolation disabled');
      assert(prefs.nodeIntegration === false, 'nodeIntegration enabled');
      assert(prefs.webSecurity === true, 'webSecurity disabled');
      assert(prefs.webviewTag === false, 'webview enabled');
      return { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true };
    });

    await run('packaged preload and renderer labels', async () => {
      const state = await waitForRendererState(runtime, `(() => {
        const state = {
          hasApi: Boolean(window.warController),
          apiKeys: Object.keys(window.warController || {}).sort(),
          text: document.body.innerText
        };
        return ${JSON.stringify(VIEW_LABELS)}.every((label) => state.text.includes(label)) ? state : null;
      })()`);
      assert(state.hasApi, 'preload API missing');
      for (const label of VIEW_LABELS) assert(state.text.includes(label), `missing visible label: ${label}`);
      return { apiKeys: state.apiKeys, labels: VIEW_LABELS };
    });

    await run('packaged seven-view navigation', async () => {
      const states = await js(runtime, `(async () => {
        const out = [];
        for (const label of ${JSON.stringify(VIEW_LABELS)}) {
          const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === label);
          if (!button) { out.push({ label, ok: false, reason: 'missing' }); continue; }
          button.click();
          await new Promise((resolve) => setTimeout(resolve, 60));
          out.push({ label, ok: document.body.innerText.includes(label) });
        }
        return out;
      })()`);
      assert(states.every((item) => item.ok), 'not all views opened');
      return states;
    });

    await run('packaged state persistence restart-safe location', async () => {
      const statePath = runtime.config.storePath;
      assert(!statePath.includes('app.asar'), 'state path points inside app.asar');
      assert(path.resolve(statePath).startsWith(path.resolve(runtime.config.dataPath)), 'state is outside configured data path');
      await js(runtime, `window.warController.groups.create({ name: 'Packaged Persisted Group' })`);
      assert(fs.existsSync(statePath), 'state file was not created');
      return { stateFile: path.basename(statePath), dataPathBase: path.basename(runtime.config.dataPath) };
    });

    await run('packaged WSS status', async () => {
      const status = runtime.application.getRuntimeStatus().data;
      const expectedEnabled = process.env.WAR_CONTROLLER_WSS_ENABLED === '1';
      assert(Boolean(status.enabled) === expectedEnabled, 'WSS enabled state mismatch');
      if (expectedEnabled) assert(status.port > 0, 'WSS enabled without bound port');
      return {
        status: status.status,
        enabled: Boolean(status.enabled),
        bindHost: status.bindHost,
        port: status.port,
        storeStatus: status.storeStatus,
      };
    });
  } catch {
    // The failure is captured in results and reflected in process.exitCode below.
  } finally {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      appPackaged: app.isPackaged,
      electronVersion: process.versions.electron,
      nodeVersion: process.version,
      results,
    }, null, 2)}\n`);
    await runtime.shutdown().catch(() => {});
    process.exitCode = failed ? 1 : 0;
    app.quit();
  }
}

function js(runtime, source) {
  return runtime.mainWindow.webContents.executeJavaScript(source, true);
}

async function waitForRendererState(runtime, source, timeoutMs = 5000) {
  const start = Date.now();
  let lastState = null;
  while (Date.now() - start < timeoutMs) {
    lastState = await js(runtime, source);
    if (lastState) return lastState;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return lastState || await js(runtime, `({
    hasApi: Boolean(window.warController),
    apiKeys: Object.keys(window.warController || {}).sort(),
    text: document.body.innerText
  })`);
}

async function waitForRendererUrl(webContents, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const url = webContents?.getURL?.() || '';
    if (url.startsWith('war-controller://app/')) return url;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return webContents?.getURL?.() || '';
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function redactPath(value) {
  return String(value || '').replaceAll(process.env.USERPROFILE || '', '<home>');
}
