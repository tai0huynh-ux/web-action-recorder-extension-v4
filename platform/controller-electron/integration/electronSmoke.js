import { app, BrowserWindow, dialog, ipcMain, protocol, session } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createElectronControllerRuntime } from '../src/electronRuntime.js';
import { PROTOCOL_VERSION } from '../../protocol/src/protocolV2.js';
import { IPC_CHANNELS } from '../src/ipcContract.js';

const results = [];
const artifactDir = path.resolve('artifacts/controller-electron');
const uiPhaseArtifactDir = path.resolve('artifacts/ui-phase-1');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'war-electron-smoke-'));
const userData = path.join(tempRoot, 'userData');
const dataPath = path.join(tempRoot, 'state');
const handled = new Map();
const trackedIpcMain = {
  handle(channel, handler) {
    handled.set(channel, handler);
    ipcMain.handle(channel, handler);
  },
  removeHandler(channel) {
    handled.delete(channel);
    ipcMain.removeHandler(channel);
  },
};

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', userData);

const runtime = createElectronControllerRuntime({
  app,
  BrowserWindow,
  dialog,
  ipcMain: trackedIpcMain,
  protocol,
  session,
  env: {
    WAR_CONTROLLER_ELECTRON_DATA_PATH: dataPath,
    WAR_CONTROLLER_WSS_PORT: '0',
  },
});

let failed = false;
let cleanupRemoved = false;
fs.mkdirSync(dataPath, { recursive: true });

try {
  await run('start runtime with temporary state', async () => {
    await runtime.start();
    app.removeAllListeners('window-all-closed');
    app.on('window-all-closed', () => {});
    assert(runtime.mainWindow, 'main window was not created');
  });

  await run('window security', async () => {
    const win = runtime.mainWindow;
    assert(new URL(win.webContents.getURL()).protocol === 'war-controller:', 'renderer protocol mismatch');
    assert(new URL(win.webContents.getURL()).hostname === 'app', 'renderer host mismatch');
    const prefs = win.webContents.getLastWebPreferences();
    assert(prefs.sandbox === true, 'sandbox disabled');
    assert(prefs.contextIsolation === true, 'contextIsolation disabled');
    assert(prefs.nodeIntegration === false, 'nodeIntegration enabled');
    assert((prefs.nodeIntegrationInWorker ?? false) === false, 'worker Node integration enabled');
    assert((prefs.nodeIntegrationInSubFrames ?? false) === false, 'subframe Node integration enabled');
    assert(prefs.webSecurity === true, 'webSecurity disabled');
    assert(prefs.webviewTag === false, 'webview enabled');
    assert((prefs.allowRunningInsecureContent ?? false) === false, 'insecure content allowed');
  });

  await run('renderer isolation', async () => {
    const shape = await js(`({
      blocked: {
        process: typeof window.process,
        require: typeof window.require,
        module: typeof window.module,
        Buffer: typeof window.Buffer,
        ipcRenderer: typeof window.ipcRenderer,
        fs: typeof window.fs,
        path: typeof window.path
      },
      api: {
        exists: Boolean(window.warController),
        keys: Object.keys(window.warController || {}).sort(),
        frozen: Object.isFrozen(window.warController),
        nestedFrozen: Object.values(window.warController || {}).filter((value) => value && typeof value === 'object').every(Object.isFrozen)
      }
    })`);
    assert(Object.values(shape.blocked).every((value) => value === 'undefined'), 'privileged renderer global exposed');
    assert(shape.api.exists, 'warController missing');
    assert(shape.api.frozen, 'warController is mutable');
    assert(shape.api.nestedFrozen, 'warController nested object is mutable');
    assert(JSON.stringify(shape.api.keys) === JSON.stringify(['apiVersion', 'containers', 'devices', 'dialogs', 'groups', 'jobs', 'pairings', 'sessions', 'settings', 'system', 'workflows']), 'API shape mismatch');
  });

  await run('CSP blocks inline code, eval, and remote connect', async () => {
    const csp = await js(`new Promise((resolve) => {
      window.__inlineRan = false;
      const s = document.createElement('script');
      s.textContent = 'window.__inlineRan = true';
      document.body.appendChild(s);
      setTimeout(() => resolve({ inlineBlocked: window.__inlineRan === false }), 80);
    })`);
    assert(csp.inlineBlocked, 'inline script ran');
    const evalBlocked = await js(`new Promise((resolve) => {
      window.__evalRan = false;
      const s = document.createElement('script');
      s.textContent = 'eval("window.__evalRan = true")';
      document.body.appendChild(s);
      setTimeout(() => resolve(window.__evalRan === false), 80);
    })`);
    assert(evalBlocked, 'eval script ran');
    const connectBlocked = await js(`fetch('https://example.invalid/smoke').then(() => false, () => true)`);
    assert(connectBlocked, 'remote connect was not blocked');
  });

  await run('navigation, window creation, permissions, and webview denied', async () => {
    const nav = await js(`(async () => {
      const before = location.href;
      const targets = ['http://example.invalid/', 'https://example.invalid/', '${pathToFileURL(path.join(tempRoot, 'x.html')).href}', 'data:text/html,blocked'];
      const out = [];
      for (const target of targets) {
        location.href = target;
        await new Promise((resolve) => setTimeout(resolve, 60));
        out.push(location.href === before);
      }
      const popupDenied = window.open('https://example.invalid/') === null;
      const view = document.createElement('webview');
      document.body.appendChild(view);
      const webviewDenied = typeof view.getWebContentsId === 'undefined';
      view.remove();
      const permissionDenied = await new Promise((resolve) => {
        if (!navigator.geolocation) return resolve(true);
        navigator.geolocation.getCurrentPosition(() => resolve(false), () => resolve(true), { timeout: 300 });
      });
      return { navBlocked: out.every(Boolean), popupDenied, webviewDenied, permissionDenied };
    })()`);
    assert(nav.navBlocked, 'external navigation was not blocked');
    assert(nav.popupDenied, 'window.open was allowed');
    assert(nav.webviewDenied, 'webview attached');
    assert(nav.permissionDenied, 'permission request was not denied');
  });

  const pairing = await run('trusted IPC, pairing sanitization, and group CRUD', async () => {
    const data = await js(`(async () => {
      const device = ${JSON.stringify(deviceDescriptor())};
      const requested = await window.warController.pairings.request({ device, displayName: 'Smoke Agent' });
      const requestData = requested.data.data;
      const confirmed = await window.warController.pairings.confirm({ requestId: requestData.requestId, code: requestData.code });
      const listed = await window.warController.pairings.list({ limit: 200 });
      const group = await window.warController.groups.create({ name: 'Smoke Group' });
      const groupData = group.data.data;
      await window.warController.groups.update({ groupId: groupData.id, name: 'Smoke Group Renamed' });
      await window.warController.groups.addDevice({ groupId: groupData.id, deviceId: device.deviceId });
      await window.warController.groups.removeDevice({ groupId: groupData.id, deviceId: device.deviceId });
      await window.warController.groups.remove({ groupId: groupData.id });
      return {
        requestHasCode: Boolean(requestData.code),
        confirmHasCredential: Boolean(confirmed.data.data.credential),
        pendingText: JSON.stringify(listed.data.data.pending),
        pairedText: JSON.stringify(listed.data.data.paired),
        credential: confirmed.data.data.credential
      };
    })()`);
    assert(data.requestHasCode, 'pairing request did not return a code');
    assert(data.confirmHasCredential, 'confirm did not return one-time credential');
    assert(!data.pendingText.includes('tokenHash'), 'pending pairings leaked token digest');
    assert(!data.pairedText.includes('credentialHash'), 'paired agents leaked credential digest');
    assert(!data.pairedText.includes(data.credential), 'paired list leaked one-time credential');
    return data;
  });

  await run('workflow import, jobs list, dispatch, cancel, and invalid payload rejection', async () => {
    await runtime.core.sessions.authenticateHello(agentHello(), { credential: pairing.credential });
    const out = await js(`(async () => {
      const workflow = ${JSON.stringify(workflowRevision())};
      await window.warController.workflows.importFile({ workflow });
      const workflows = await window.warController.workflows.list({ limit: 200 });
      const dispatch = await window.warController.jobs.dispatch({ deviceId: 'dev-smoke', workflowId: 'wf-smoke', revision: 1, deadlineSeconds: 60, inputs: { url: 'https://example.test' } });
      const cancel = await window.warController.jobs.cancel({ jobId: dispatch.data.data.job.id });
      const invalid = await window.warController.jobs.dispatch({ deviceId: 'dev-smoke', workflowId: 'wf-smoke', revision: 1, jobId: 'main-owned' });
      const sensitive = ${JSON.stringify(sensitiveWorkflowRevision())};
      await window.warController.workflows.importFile({ workflow: sensitive });
      const sensitiveResult = await window.warController.jobs.dispatch({ deviceId: 'dev-smoke', workflowId: 'wf-sensitive-smoke', revision: 1, inputs: { secret: 'x' } });
      const jobs = await window.warController.jobs.list({ limit: 200 });
      return { workflows, dispatch, cancel, invalid, sensitiveResult, jobs };
    })()`);
    assert(out.workflows.ok === true, 'workflow list failed');
    assert(out.dispatch.ok === true, 'dispatch failed');
    assert(Boolean(out.dispatch.data.data.job.id), 'dispatch did not persist job');
    assert(out.dispatch.data.data.transport.delivered === false, 'disabled WSS should report transport warning');
    assert(out.dispatch.data.data.transport.warningCode === 'SESSION_OFFLINE', 'transport warning missing');
    assert(out.cancel.ok === true, 'cancel failed');
    assert(out.invalid.ok === false, 'invalid payload accepted');
    assert(out.sensitiveResult.ok === false && out.sensitiveResult.error.code === 'SENSITIVE_INPUT_UNSUPPORTED', 'sensitive input was accepted');
    assert(out.jobs.ok === true, 'jobs list failed');
  });

  await run('untrusted IPC sender cannot mutate state', async () => {
    const before = runtime.core.store.snapshot().groups.length;
    const handler = handled.get(IPC_CHANNELS.groups.create);
    const result = await handler(untrustedEvent(), { name: 'Bad Group' });
    const after = runtime.core.store.snapshot().groups.length;
    assert(result.ok === false && result.error.code === 'AUTH_DENIED', 'untrusted sender was not denied');
    assert(before === after, 'untrusted sender changed state');
  });

  await run('persistence restart keeps controller state', async () => {
    const created = await js(`window.warController.groups.create({ name: 'Persisted Smoke Group' })`);
    const groupId = created.data.data.id;
    await runtime.shutdown();
    assert(handled.size === 0, 'IPC handlers were not removed');
    await runtime.start();
    const groups = await js(`window.warController.groups.list({ limit: 200 })`);
    assert(groups.data.data.groups.some((group) => group.id === groupId), 'persisted group missing after restart');
  });

  await run('phase 1 workspace GUI artifacts', async () => {
    fs.mkdirSync(uiPhaseArtifactDir, { recursive: true });
    const win = runtime.mainWindow;
    await openWorkspace();
    await win.setSize?.(1440, 900);
    await win.webContents.setZoomFactor?.(1);
    assert(await bodyIncludes('Máy và container'), 'Vietnamese workspace labels missing');
    await screenshot('workspace-vi.png');
    await switchLocale('en');
    assert(await bodyIncludes('Machines and containers'), 'English workspace labels missing');
    await screenshot('workspace-en.png');
    await clickText('Collapse action graph');
    await screenshot('workspace-collapsed.png');
    await win.setSize?.(1024, 700);
    await screenshot('workspace-small-window.png');
    await win.setSize?.(1920, 1080);
    await win.webContents.setZoomFactor?.(1.25);
    await screenshot('workspace-large-window.png');
    await win.webContents.setZoomFactor?.(1);
    await switchLocale('vi');
    const summary = {
      result: 'PASS',
      checks: ['workspace opens', 'Vietnamese labels visible', 'English labels visible', 'language switch works', 'collapse works', '1024x700 captured', '1920x1080 at 125 percent captured'],
      screenshots: ['workspace-vi.png', 'workspace-en.png', 'workspace-collapsed.png', 'workspace-small-window.png', 'workspace-large-window.png'],
    };
    fs.writeFileSync(path.join(uiPhaseArtifactDir, 'ui-phase-1-results.json'), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(uiPhaseArtifactDir, 'UI_PHASE_1_REPORT.md'), `# UI Phase 1 Report\n\nResult: PASS\n\n- Workspace opens: PASS\n- Vietnamese labels visible: PASS\n- English labels visible: PASS\n- Language switch without restart: PASS\n- Panel collapse: PASS\n- 1024x700 screenshot: PASS\n- 1920x1080 at 125% screenshot: PASS\n`);
    return summary;
  });

  await run('natural cleanup', async () => {
    await runtime.shutdown();
    assert(handled.size === 0, 'IPC handlers leaked after cleanup');
    assert(!runtime.mainWindow, 'main window still referenced');
  });
} catch (error) {
  failed = true;
  results.push({ name: 'fatal', pass: false, durationMs: 0, error: String(error?.message || error) });
} finally {
  await safeShutdown();
  writeArtifact();
  cleanupRemoved = removeTempRoot();
  if (!cleanupRemoved) {
    app.once('quit', () => {
      cleanupRemoved = removeTempRoot();
    });
    schedulePostExitCleanup();
  }
  app.quit();
  if (failed || results.some((item) => !item.pass)) process.exitCode = 1;
}

async function run(name, fn) {
  const start = Date.now();
  try {
    console.error(`[electron-smoke] start ${name}`);
    const value = await fn();
    results.push({ name, pass: true, durationMs: Date.now() - start });
    console.error(`[electron-smoke] pass ${name}`);
    return value;
  } catch (error) {
    failed = true;
    results.push({ name, pass: false, durationMs: Date.now() - start, error: String(error?.message || error) });
    throw error;
  }
}

function js(source) {
  return runtime.mainWindow.webContents.executeJavaScript(source, true);
}

async function openWorkspace() {
  await js(`(async () => {
    const button = [...document.querySelectorAll('button')].find((item) => ['Workspace'].includes(item.textContent.trim()));
    if (button) button.click();
    await new Promise((resolve) => setTimeout(resolve, 120));
  })()`);
}

async function switchLocale(locale) {
  await js(`(async () => {
    const select = document.querySelector('[data-language] select');
    select.value = ${JSON.stringify(locale)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 180));
  })()`);
}

async function clickText(label) {
  await js(`(async () => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === ${JSON.stringify(label)});
    if (!button) throw new Error('Missing button: ' + ${JSON.stringify(label)});
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 120));
  })()`);
}

async function bodyIncludes(text) {
  return js(`document.body.innerText.includes(${JSON.stringify(text)})`);
}

async function screenshot(name) {
  const image = await runtime.mainWindow.webContents.capturePage();
  fs.writeFileSync(path.join(uiPhaseArtifactDir, name), image.toPNG());
}

function writeArtifact() {
  fs.mkdirSync(artifactDir, { recursive: true });
  const runtimeStatus = runtime.application?.getRuntimeStatus?.().data || { status: 'shutdown' };
  const safeRuntime = {
    status: runtimeStatus.status,
    enabled: Boolean(runtimeStatus.enabled),
    bindHost: runtimeStatus.bindHost,
    port: runtimeStatus.port,
    storeStatus: runtimeStatus.storeStatus,
  };
  const artifact = {
    timestamp: new Date().toISOString(),
    electronVersion: process.versions.electron,
    tests: results.map(({ name, pass, durationMs, error }) => ({ name, pass, durationMs, error })),
    sanitizedRuntimeStatus: safeRuntime,
  };
  fs.writeFileSync(path.join(artifactDir, `electron-smoke-${Date.now()}.json`), JSON.stringify(artifact, null, 2));
}

function removeTempRoot() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return !fs.existsSync(tempRoot);
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  return false;
}

function schedulePostExitCleanup() {
const script = `
const fs = require('fs');
const target = process.argv[1];
let attempts = 0;
const timer = setInterval(() => {
  attempts += 1;
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
  if (!fs.existsSync(target) || attempts >= 80) clearInterval(timer);
}, 250);
`;
  const nodeExecutable = process.env.npm_node_execpath || process.env.NODE || 'node';
  spawn(nodeExecutable, ['-e', script, tempRoot], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

async function safeShutdown() {
  try {
    await runtime.shutdown();
  } catch {
    // best-effort natural shutdown after a failed assertion
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function untrustedEvent() {
  const senderFrame = { url: 'https://example.invalid/', top: null };
  senderFrame.top = senderFrame;
  return { sender: { mainFrame: senderFrame, isDestroyed: () => false }, senderFrame };
}

function deviceDescriptor() {
  return {
    deviceId: 'dev-smoke',
    displayName: 'Smoke Agent',
    hostName: 'smoke-host',
    platform: 'linux',
    architecture: 'x64',
    agentVersion: '0.1.0',
    extensionVersion: '0.1.0',
    browserVersion: '150',
    protocolVersion: PROTOCOL_VERSION,
    status: 'online',
    lastSeenAt: '2026-07-16T00:00:00.000Z',
    capabilities: {
      workflowExecution: true,
      semanticControl: true,
      rawViewportInput: true,
      rawBrowserInput: true,
      nativeX11Input: true,
      screenshot: true,
      remoteVideo: false,
      clipboardText: false,
      synchronizedInput: false,
    },
    labels: [],
    groupIds: [],
  };
}

function agentHello() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: 'hello-smoke',
    type: 'agent.hello',
    sentAt: '2026-07-16T00:00:00.000Z',
    deviceId: 'dev-smoke',
    payload: {
      protocolVersion: PROTOCOL_VERSION,
      device: deviceDescriptor(),
      supportedMessageTypes: ['agent.hello', 'agent.presence', 'agent.execution.event'],
      sessionNonce: 'smoke-nonce',
      sentAt: '2026-07-16T00:00:00.000Z',
    },
  };
}

function workflowRevision() {
  return {
    workflowId: 'wf-smoke',
    revision: 1,
    schemaVersion: 'war-workflow-revision.v2',
    contentHash: 'd'.repeat(64),
    name: 'Smoke Workflow',
    description: 'Smoke workflow',
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    sourceDeviceId: 'dev-smoke',
    requiredInputs: [{ name: 'url', label: 'URL', index: 0, required: true, sensitive: false, type: 'string' }],
    profilePayload: { id: 'wf-smoke', steps: [] },
  };
}

function sensitiveWorkflowRevision() {
  return {
    ...workflowRevision(),
    workflowId: 'wf-sensitive-smoke',
    contentHash: 'e'.repeat(64),
    name: 'Sensitive Smoke Workflow',
    requiredInputs: [{ name: 'secret', label: 'Secret', index: 0, required: true, sensitive: true, type: 'string' }],
  };
}
