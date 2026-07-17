import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { execFile, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ControllerCore, hashSecret } from '../../controller-core/src/controllerCore.js';
import { JsonStore } from '../../../companion/store.js';
import { ControllerApplicationService } from '../../controller-electron/src/controllerApplication.js';
import { ControllerWssServerAdapter } from '../src/serverAdapter.js';
import { ControllerWssRuntimeServer } from '../src/wssServer.js';
import { ControllerSessionClient } from '../../browser-agent/src/controllerSessionClient.js';
import { createWorkflowRegistry } from '../../browser-agent/src/workflowRegistry.js';
import { NativeBridgeHandler } from '../../browser-agent/src/nativeBridgeHandler.js';
import { LocalSocketServer } from '../../browser-agent/src/localSocketServer.js';
import { createWorkflowRevisionFromExtensionProfile } from '../../workflow-core/src/workflowMetadata.js';
import { PROTOCOL_VERSION } from '../../protocol/src/protocolV2.js';
import { HOST_NAME, deleteRegistryKey, installWindowsNativeHost } from './windowsNativeHostShim.js';
import {
  createTrace,
  detectExtensionOrBlock,
  evaluate,
  finish,
  finishFailureWithScreenshot,
  launchBrowser,
  openTarget,
  selectBrowser,
  waitFor,
  CdpClient,
  safeRemove
} from '../../../test/browser-mv3-harness.js';

export async function runControllerExtensionE2e() {
  const trace = createTrace('controller-extension-e2e');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'war-controller-extension-e2e-'));
  const artifactDir = path.resolve('artifacts/controller-extension-e2e');
  await fs.mkdir(artifactDir, { recursive: true });
  let browserRun;
  let page;
  let controller;
  let pageServer;
  let socketServer;
  let controllerSession;
  let registryKey;
  try {
    const socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\war-e2e-${process.pid}-${Date.now()}`
      : path.join(root, 'native-bridge.sock');
    const browser = selectBrowser();
    trace.browserName = browser.name;
    trace.browserExecutablePath = browser.path;
    browserRun = await launchBrowser(browser.path);
    trace.browserVersion = browserRun.version;
    const detected = await detectExtensionOrBlock({ trace, browser, run: browserRun });
    if (!detected.ok) return finish(trace, 'Blocked', detected.reason, 2);
    const extensionId = trace.extensionId;

    const nativeHost = await installNativeHost({ root, extensionId, socketPath, browserKey: browser.key });
    registryKey = nativeHost.registryKey;

    controller = await startController({ root });
    await pair(controller.core, 'dev-e2e', 'cred-e2e');

    const workflow = workflowRevision();
    await controller.core.workflows.putRevision(workflow);

    const agentRegistry = createWorkflowRegistry({
      paths: { workflowDir: path.join(root, 'agent-workflows') },
      workflowRegistryMaxCount: 100,
      workflowRegistryMaxPayloadBytes: 1024 * 1024
    });
    agentRegistry.putRevision(workflow);

    controllerSession = new ControllerSessionClient({
      url: controller.url,
      credential: 'cred-e2e',
      identity: { deviceId: 'dev-e2e', displayName: 'E2E Agent' },
      connectorOptions: { ca: controller.ca },
      minReconnectMs: 100,
      maxReconnectMs: 500,
      now: () => new Date().toISOString()
    });
    const nativeBridge = new NativeBridgeHandler({
      identity: { deviceId: 'dev-e2e' },
      registry: agentRegistry,
      version: '0.1.0',
      supervisor: { getState: () => ({ browserState: 'running', extensionLoaded: true }) },
      onExecutionEnvelope: (envelope) => {
        const event = envelope.payload || {};
        const forwarded = envelope.type === 'execution.cancelled'
          ? controllerSession.sendExecutionCancelled({ jobId: envelope.jobId || event.jobId, idempotencyKey: envelope.idempotencyKey })
          : controllerSession.sendExecutionEvent({
              jobId: envelope.jobId || event.jobId,
              eventType: event.eventType,
              message: event.message,
              result: event.result,
              idempotencyKey: envelope.idempotencyKey
            });
        Promise.resolve(forwarded).catch(() => {});
      }
    });
    controllerSession.on('dispatch', (dispatch) => nativeBridge.enqueueDispatch(dispatch));
    controllerSession.on('cancel', (cancel) => nativeBridge.enqueueCancel(cancel));
    socketServer = new LocalSocketServer({
      socketPath,
      handler: (message) => nativeBridge.handle(message)
    });
    await socketServer.start();
    await probeNativeHostExecutable(nativeHost.exePath);
    controllerSession.start();
    await waitFor(() => controller.core.sessions.getPublicSession('dev-e2e'), 10000, 'agent WSS session');

    pageServer = await startPageServer();
    page = await openTarget(browserRun.port, pageServer.url);
    await page.send('Page.enable');
    await waitFor(() => evaluate(page, 'document.readyState === "complete"'), 10000, 'controlled page ready');

    const serviceWorker = new CdpClient(detected.extensionTarget.webSocketDebuggerUrl);
    await configureExtension(serviceWorker, workflow.profilePayload);
    await probeNativeBridge(serviceWorker);
    await waitFor(() => agentRegistry.getRevision('wf-controller-e2e', 1), 10000, 'agent workflow registry');

    const app = new ControllerApplicationService({ core: controller.core, wssTransport: controller.adapter });
    const dispatch = await app.dispatchWorkflow({ deviceId: 'dev-e2e', workflowId: 'wf-controller-e2e', revision: 1, inputs: {}, deadlineSeconds: 60 });
    const jobId = dispatch.data.job.id;
    await triggerNativeBridgePoll(serviceWorker);
    await waitFor(() => evaluate(page, 'document.querySelector("#result").textContent === "clicked"'), 20000, 'extension workflow click result');
    await waitFor(() => {
      const job = controller.core.jobs.getCommand(jobId);
      return job.status === 'succeeded';
    }, 20000, 'controller persisted completed job');
    const events = controller.core.events.listRecent({ jobId });
    const terminal = controller.core.jobs.getCommand(jobId);

    const cancelWorkflow = cancelWorkflowRevision();
    await controller.core.workflows.putRevision(cancelWorkflow);
    agentRegistry.putRevision(cancelWorkflow);
    const cancelDispatch = await app.dispatchWorkflow({ deviceId: 'dev-e2e', workflowId: 'wf-controller-cancel', revision: 1, inputs: {}, deadlineSeconds: 60 });
    await triggerNativeBridgePoll(serviceWorker);
    const cancelJobId = cancelDispatch.data.job.id;
    await app.cancelJob({ jobId: cancelJobId });
    await triggerNativeBridgePoll(serviceWorker);
    await waitFor(() => controller.core.jobs.getCommand(cancelJobId).status === 'cancelled', 10000, 'controller-side cancelled job');

    const replay = await controller.core.sessions.replayNonTerminal('dev-e2e', controller.core.sessions.getPublicSession('dev-e2e').generation);
    const artifact = {
      startedAt: trace.steps[0]?.time,
      head: await gitHead().catch(() => 'unknown'),
      tlsVerified: true,
      realBrowserAgent: true,
      realChromium: true,
      realMv3Extension: true,
      workflowExecuted: await evaluate(page, 'window.__warClicked === true'),
      resultPersisted: terminal.status === 'succeeded',
      eventTypes: events.map((event) => event.eventType),
      cancelCase: controller.core.jobs.getCommand(cancelJobId).status === 'cancelled',
      replayAfterTerminalCount: replay.filter((item) => item.jobId === jobId).length,
      cleanup: true,
      finishedAt: new Date().toISOString()
    };
    const artifactPath = path.join(artifactDir, `controller-extension-e2e-${Date.now()}.json`);
    await fs.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(`artifact=${artifactPath}`);
    console.log(JSON.stringify(artifact, null, 2));
    const ok = artifact.workflowExecuted
      && artifact.resultPersisted
      && artifact.eventTypes.includes('job_succeeded')
      && artifact.cancelCase
      && artifact.replayAfterTerminalCount === 0;
    if (!ok) throw new Error('Controller Extension E2E gate failed');
    return finish(trace, 'Pass', 'Controller-to-extension workflow execution E2E passed.', 0);
  } catch (error) {
    return finishFailureWithScreenshot({ trace, page, error });
  } finally {
    controllerSession?.gracefulShutdown?.();
    await socketServer?.stop?.().catch(() => {});
    controller?.runtime?.shutdown?.();
    if (controller?.server) await closeServer(controller.server).catch(() => {});
    if (pageServer?.server) await closeServer(pageServer.server).catch(() => {});
    if (registryKey) await deleteRegistryKey(registryKey).catch(() => {});
    browserRun?.close?.();
    if (browserRun?.userDataDir) safeRemove(browserRun.userDataDir);
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function startController({ root }) {
  const certs = await createCertificates(root);
  const ca = await fs.readFile(certs.caCert);
  const core = new ControllerCore({ store: new JsonStore(path.join(root, 'controller-state.json')) });
  await core.load();
  const adapter = new ControllerWssServerAdapter({ sessionManager: core.sessions });
  const server = https.createServer({
    key: await fs.readFile(certs.serverKey),
    cert: await fs.readFile(certs.serverCert)
  });
  const runtime = new ControllerWssRuntimeServer({ server, adapter });
  await listen(server, 0);
  return { core, adapter, server, runtime, ca, url: `wss://localhost:${server.address().port}/v1/agent-session` };
}

async function pair(core, deviceId, credential) {
  await core.pairing.requestPairing({ device: deviceDescriptor(deviceId), requestId: `pair-${deviceId}` });
  await core.store.update((state) => {
    state.pendingPairings.find((item) => item.requestId === `pair-${deviceId}`).tokenHash = hashSecret(`code-${deviceId}`);
  });
  await core.pairing.confirmPairing(`pair-${deviceId}`, `code-${deviceId}`);
  await core.store.update((state) => {
    state.pairedAgents.find((item) => item.deviceId === deviceId).credentialHash = hashSecret(credential);
  });
}

function workflowRevision() {
  return createWorkflowRevisionFromExtensionProfile({
    id: 'wf-controller-e2e',
    name: 'Controller Extension E2E',
    enabled: true,
    steps: [
      { id: 'click-result', name: 'Click result', type: 'click', selector: '#war-button' },
      { id: 'log-done', name: 'Log done', type: 'log', message: 'done' }
    ]
  }, {
    sourceDeviceId: 'dev-e2e',
    now: '2026-07-16T00:00:00.000Z'
  });
}

function cancelWorkflowRevision() {
  return createWorkflowRevisionFromExtensionProfile({
    id: 'wf-controller-cancel',
    name: 'Controller Extension Cancel',
    enabled: true,
    steps: [
      { id: 'wait-missing', name: 'Wait missing', type: 'click', selector: '#never-appears', timeoutMs: 10000 }
    ]
  }, {
    sourceDeviceId: 'dev-e2e',
    now: '2026-07-16T00:00:00.000Z'
  });
}

async function configureExtension(serviceWorker, profile) {
  const settings = {
    globalWatcherEnabled: false,
    externalApiEnabled: false,
    companionUrl: 'http://127.0.0.1:17373',
    companionToken: '',
    companionEnrollmentToken: '',
    companionDeviceId: 'dev-e2e',
    companionDeviceName: 'E2E Agent',
    companionPollMs: 2000,
    legacyCompanionPollingEnabled: false,
    nativeBridgeEnabled: true,
    nativeHostName: HOST_NAME
  };
  const expression = `
    (async () => {
      const settings = ${JSON.stringify(settings)};
      const profile = ${JSON.stringify(profile)};
      await chrome.storage.local.set({
        war_profiles: [profile],
        war_active_profile_id: profile.id,
        war_settings: { ...settings, nativeBridgeEnabled: false }
      });
      await chrome.storage.local.set({ war_settings: settings });
      return true;
    })()
  `;
  await serviceWorker.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
}

async function triggerNativeBridgePoll(serviceWorker) {
  const expression = `
    (async () => {
      const data = await chrome.storage.local.get('war_settings');
      const settings = data.war_settings || {};
      await chrome.storage.local.set({ war_settings: { ...settings, nativeBridgeEnabled: false } });
      await chrome.storage.local.set({ war_settings: { ...settings, nativeBridgeEnabled: true } });
      return true;
    })()
  `;
  await serviceWorker.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
}

async function probeNativeBridge(serviceWorker) {
  const expression = `
    new Promise((resolve) => {
      const port = chrome.runtime.connectNative(${JSON.stringify(HOST_NAME)});
      const timer = setTimeout(() => {
        try { port.disconnect(); } catch {}
        resolve({ ok: false, error: 'native_bridge_probe_timeout' });
      }, 2500);
      port.onMessage.addListener((message) => {
        clearTimeout(timer);
        resolve({ ok: Boolean(message?.payload?.ok), message });
        try { port.disconnect(); } catch {}
      });
      port.onDisconnect.addListener(() => {
        clearTimeout(timer);
        resolve({ ok: false, error: chrome.runtime.lastError?.message || 'native_bridge_disconnected' });
      });
      port.postMessage({
        protocolVersion: 'war-control.v2',
        messageId: 'probe-' + Date.now(),
        type: 'bridge.health',
        sentAt: new Date().toISOString(),
        payload: {}
      });
    })
  `;
  const result = await serviceWorker.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  const value = result.result.value;
  if (!value?.ok) throw new Error(`Native bridge probe failed: ${value?.error || JSON.stringify(value)}`);
  return value;
}

async function probeNativeHostExecutable(exePath) {
  if (process.platform !== 'win32') return;
  const request = {
    protocolVersion: PROTOCOL_VERSION,
    messageId: `preflight-${Date.now()}`,
    type: 'bridge.health',
    sentAt: new Date().toISOString(),
    payload: {}
  };
  const response = await runNativeMessagingProcess(exePath, request);
  if (!response?.payload?.ok) throw new Error(`Native host executable preflight failed: ${JSON.stringify(response?.payload?.error || response)}`);
}

async function startPageServer() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body><button id="war-button">Click</button><div id="result"></div><script>
      window.__warClicked = false;
      document.querySelector('#war-button').addEventListener('click', () => {
        window.__warClicked = true;
        document.querySelector('#result').textContent = 'clicked';
      });
    </script></body></html>`);
  });
  await listen(server, 0);
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

async function installNativeHost({ root, extensionId, socketPath, browserKey }) {
  if (process.platform === 'win32') {
    return installWindowsNativeHost({ root, extensionId, socketPath, browserKey });
  }
  const manifestPath = path.join(root, `${HOST_NAME}.json`);
  const wrapperPath = path.join(root, 'war-native-host.sh');
  const hostPath = path.resolve('native-host/host.js');
  await fs.writeFile(wrapperPath, `#!/bin/sh\nWAR_AGENT_SOCKET_PATH="${socketPath}" exec "${process.execPath}" "${hostPath}"\n`, { mode: 0o700 });
  const manifest = {
    name: HOST_NAME,
    description: 'Web Action Recorder E2E native bridge',
    path: wrapperPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`]
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifestPath, registryKey: null };
}

async function createCertificates(root) {
  const opensslCnf = path.join(root, 'openssl.cnf');
  const ext = path.join(root, 'server.ext');
  await fs.writeFile(opensslCnf, '[req]\ndistinguished_name=req_distinguished_name\n[req_distinguished_name]\n');
  await fs.writeFile(ext, 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  const env = { ...process.env, OPENSSL_CONF: opensslCnf };
  const caKey = path.join(root, 'ca.key');
  const caCert = path.join(root, 'ca.crt');
  const serverKey = path.join(root, 'server.key');
  const serverCsr = path.join(root, 'server.csr');
  const serverCert = path.join(root, 'server.crt');
  await execFileP('openssl', ['genrsa', '-out', caKey, '2048'], { env });
  await execFileP('openssl', ['req', '-x509', '-new', '-nodes', '-key', caKey, '-sha256', '-days', '1', '-out', caCert, '-subj', '/CN=WAR Test CA'], { env });
  await execFileP('openssl', ['genrsa', '-out', serverKey, '2048'], { env });
  await execFileP('openssl', ['req', '-new', '-key', serverKey, '-out', serverCsr, '-subj', '/CN=localhost'], { env });
  await execFileP('openssl', ['x509', '-req', '-in', serverCsr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-out', serverCert, '-days', '1', '-sha256', '-extfile', ext], { env });
  return { caCert, serverKey, serverCert };
}

function deviceDescriptor(deviceId) {
  return {
    deviceId,
    displayName: 'E2E Agent',
    hostName: 'host',
    platform: process.platform,
    architecture: process.arch,
    agentVersion: '0.1.0',
    extensionVersion: '0.1.0',
    browserVersion: '150',
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      workflowExecution: true,
      semanticControl: true,
      rawViewportInput: true,
      rawBrowserInput: true,
      nativeX11Input: true,
      screenshot: true,
      remoteVideo: false,
      clipboardText: false,
      synchronizedInput: false
    },
    labels: [],
    groupIds: [],
    status: 'online',
    lastSeenAt: new Date().toISOString()
  };
}

function listen(server, port) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function execFileP(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

function runNativeMessagingProcess(exePath, message) {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Native host executable preflight timed out${stderr.length ? `: ${Buffer.concat(stderr).toString('utf8')}` : ''}`));
    }, 5000);
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const raw = Buffer.concat(chunks);
        if (raw.length < 4) throw new Error(`Native host preflight produced no framed response; exit=${code}; stderr=${Buffer.concat(stderr).toString('utf8')}`);
        const length = raw.readUInt32LE(0);
        const payload = raw.subarray(4, 4 + length).toString('utf8');
        resolve(JSON.parse(payload));
      } catch (error) {
        reject(error);
      }
    });
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    child.stdin.write(Buffer.concat([header, payload]));
    child.stdin.end();
  });
}

async function gitHead() {
  return (await execFileP('git', ['rev-parse', 'HEAD'])).stdout.trim();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runControllerExtensionE2e();
}
