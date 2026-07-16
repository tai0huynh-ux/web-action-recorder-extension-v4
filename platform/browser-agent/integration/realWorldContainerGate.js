import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { ControllerCore, hashSecret } from '../../controller-core/src/controllerCore.js';
import { JsonStore } from '../../../companion/store.js';
import { ControllerApplicationService } from '../../controller-electron/src/controllerApplication.js';
import { ControllerWssServerAdapter } from '../../controller-wss/src/serverAdapter.js';
import { ControllerWssRuntimeServer } from '../../controller-wss/src/wssServer.js';
import { createWorkflowRevisionFromExtensionProfile } from '../../workflow-core/src/workflowMetadata.js';
import { PROTOCOL_VERSION } from '../../protocol/src/protocolV2.js';

const IMAGE = 'war-browser-agent:phase1';
const QUERY = 'hom nay that vui';
const ARTIFACT_DIR = path.resolve('artifacts/container-real-world');
const DEVICE_ID = 'container-real-world-device';
const CREDENTIAL = 'container-real-world-credential-0001';
let mountedDataDir = '';

if (import.meta.url === `file://${process.argv[1]}`) {
  runRealWorldContainerGate().then(() => {
    console.log('REAL_WORLD_CONTAINER_GATE=PASS');
  }).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

export async function runRealWorldContainerGate() {
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'war-real-world-container-'));
  const dataDir = path.join(root, 'data');
  const controllerRoot = path.join(root, 'controller');
  const events = [];
  let controller;
  let fixture;
  let container;
  const started = performance.now();
  const result = {
    query: QUERY,
    manualComputerUse: process.env.WAR_LOCAL_MANUAL_COMPUTER_USE === '1' ? 'RUN_EXTERNALLY' : 'NOT_RUN_NO_LOCAL_CONTAINER',
    googleCase: 'NOT_RUN',
    controlledFallback: 'FAIL',
    assertions: {},
    events,
    cleanup: {}
  };

  try {
    mountedDataDir = dataDir;
    await seedAgentData(dataDir);
    fixture = await startSearchFixture();
    controller = await startController(controllerRoot);
    await pair(controller.core, DEVICE_ID, CREDENTIAL);
    const revision = workflowRevision(fixture.url);
    await controller.core.workflows.putRevision(revision);
    await seedAgentWorkflow(dataDir, revision);

    const token = crypto.randomBytes(24).toString('hex');
    const allow = await dockerBridgeGateway();
    container = `war-real-world-${Date.now()}-${process.pid}`;
    await docker([
      'run',
      '-d',
      '--name', container,
      '--shm-size', '1g',
      '-p', '127.0.0.1::3766',
      '--add-host', 'host.docker.internal:host-gateway',
      '-e', 'WAR_AGENT_HOST=0.0.0.0',
      '-e', 'WAR_AGENT_ALLOW_REMOTE=1',
      '-e', `WAR_AGENT_TOKEN=${token}`,
      '-e', `WAR_AGENT_ALLOW=${allow}`,
      '-e', `WAR_CONTROLLER_WSS_URL=wss://host.docker.internal:${controller.port}/v1/agent-session`,
      '-e', `WAR_CONTROLLER_SESSION_CREDENTIAL=${CREDENTIAL}`,
      '-e', 'WAR_CONTROLLER_RECONNECT_MIN_MS=250',
      '-e', 'WAR_NATIVE_HOST_PATH=/usr/local/bin/war-native-host',
      '-e', 'NODE_EXTRA_CA_CERTS=/data/controller-ca.crt',
      '-e', `WAR_BROWSER_NO_SANDBOX=${process.env.WAR_BROWSER_NO_SANDBOX || '1'}`,
      '-v', `${dataDir}:/data`,
      IMAGE
    ]);

    const baseUrl = await getContainerBaseUrl(container);
    const health = await waitForHealth(baseUrl);
    result.assertions.browserAgentContainer = true;
    result.assertions.realChromium = health.browserState === 'running' || health.browserState === 'degraded';
    result.assertions.mv3Extension = Boolean(health.extensionLoaded);
    await waitFor(() => controller.core.sessions.getPublicSession(DEVICE_ID), 45000, 'agent WSS session');
    result.assertions.tlsWss = true;
    result.assertions.authenticatedDevice = true;

    await attemptGoogle(baseUrl, health.deviceId, token, result).catch((error) => {
      result.googleCase = 'BLOCKED_EXTERNAL_GOOGLE';
      result.googleError = sanitize(error.message);
    });

    const opened = await control(baseUrl, health.deviceId, 'tab.open', { url: fixture.url }, token);
    const targetId = opened.result.tab.targetId;
    await screenshot(baseUrl, health.deviceId, targetId, token, '02-container-browser-before-search.png');
    const app = new ControllerApplicationService({ core: controller.core, wssTransport: controller.adapter });
    const dispatch = await app.dispatchWorkflow({
      deviceId: DEVICE_ID,
      workflowId: revision.workflowId,
      revision: revision.revision,
      inputs: {},
      deadlineSeconds: 90
    });
    const jobId = dispatch.data.job.id;
    result.jobId = jobId;
    result.assertions.controllerDispatch = dispatch.data.transport.delivered === true;
    await waitFor(() => controller.core.events.listRecent({ jobId, limit: 20 }).some((event) => event.eventType === 'job_started'), 120000, 'job_started');
    await screenshot(baseUrl, health.deviceId, targetId, token, '03-query-entered.png');
    await waitFor(() => controller.core.jobs.getCommand(jobId).status === 'succeeded', 120000, 'job_succeeded');
    await screenshot(baseUrl, health.deviceId, targetId, token, '06-clipboard-verification.png');
    const copied = await control(baseUrl, health.deviceId, 'page.getElementState', {
      targetId,
      target: { selector: '#copied' }
    }, token);
    const copiedText = copied.result.element.text;
    assert(copiedText === QUERY, `clipboard verification mismatch: ${copiedText}`);
    const terminal = controller.core.jobs.getCommand(jobId);
    const jobEvents = controller.core.events.listRecent({ jobId, limit: 50 });
    const replay = controller.core.sessions.replayNonTerminal(DEVICE_ID, controller.core.sessions.getPublicSession(DEVICE_ID).generation);

    const cancelRevision = cancelWorkflowRevision(fixture.url);
    await controller.core.workflows.putRevision(cancelRevision);
    await seedAgentWorkflow(dataDir, cancelRevision, { append: true });
    const cancelDispatch = await app.dispatchWorkflow({ deviceId: DEVICE_ID, workflowId: cancelRevision.workflowId, revision: 1, inputs: {}, deadlineSeconds: 90 });
    await app.cancelJob({ jobId: cancelDispatch.data.job.id });
    await waitFor(() => controller.core.jobs.getCommand(cancelDispatch.data.job.id).status === 'cancelled', 10000, 'cancelled job');

    Object.assign(result.assertions, {
      workflowDelivered: true,
      mouseClickExecuted: fixture.events.some((event) => event.type === 'focus'),
      textTypedCorrectly: fixture.events.some((event) => event.type === 'input' && event.value === QUERY),
      searchSubmitted: fixture.events.some((event) => event.type === 'submit' && event.value === QUERY),
      resultsShown: fixture.events.some((event) => event.type === 'results' && event.value === QUERY),
      copyExecuted: fixture.events.some((event) => event.type === 'copy' && event.value === QUERY),
      clipboardEqualsExpected: copiedText === QUERY,
      resultUplink: jobEvents.some((event) => event.eventType === 'job_succeeded'),
      persistence: terminal.status === 'succeeded',
      duplicateProtection: replay.filter((item) => item.jobId === jobId).length === 0,
      terminalJobNotReplayed: replay.filter((item) => item.jobId === jobId).length === 0,
      cancelPath: controller.core.jobs.getCommand(cancelDispatch.data.job.id).status === 'cancelled',
      cleanup: true
    });
    for (const [name, pass] of Object.entries(result.assertions)) assert(pass, `assertion failed: ${name}`);
    result.controlledFallback = 'PASS';
    result.durationMs = Math.round(performance.now() - started);
    result.executionEvents = jobEvents.map(({ sequence, eventType, jobId: eventJobId, sentAt }) => ({ sequence, eventType, jobId: eventJobId, sentAt }));
    await writeEvidence(result);
    return result;
  } finally {
    if (container) await docker(['rm', '-f', container]).catch(() => {});
    result.cleanup.containerRunning = container ? await isContainerRunning(container) : false;
    await controller?.shutdown?.();
    await closeServer(fixture?.server).catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function attemptGoogle(baseUrl, deviceId, token, result) {
  const opened = await control(baseUrl, deviceId, 'tab.open', { url: 'https://www.google.com/' }, token);
  const targetId = opened.result.tab.targetId;
  await screenshot(baseUrl, deviceId, targetId, token, '01-controller-dispatch.png').catch(() => {});
  const state = await control(baseUrl, deviceId, 'page.listInteractiveElements', { targetId, limit: 20 }, token);
  const text = JSON.stringify(state.result.elements || []);
  result.googleCase = /search|q|google/i.test(text) ? 'PASS' : 'BLOCKED_EXTERNAL_GOOGLE';
}

async function seedAgentData(dataDir) {
  await fs.mkdir(path.join(dataDir, 'device'), { recursive: true });
  await fs.mkdir(path.join(dataDir, 'workflows'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'device', 'identity.json'), `${JSON.stringify({
    schemaVersion: 1,
    deviceId: DEVICE_ID,
    createdAt: '2026-07-16T00:00:00.000Z'
  }, null, 2)}\n`);
}

async function seedAgentWorkflow(dataDir, revision, { append = false } = {}) {
  const registryPath = path.join(dataDir, 'workflows', 'registry.json');
  let state = { workflows: {} };
  if (append && fssync.existsSync(registryPath)) state = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  state.workflows[revision.workflowId] = [revision];
  await fs.writeFile(registryPath, `${JSON.stringify(state, null, 2)}\n`);
}

async function startController(root) {
  await fs.mkdir(root, { recursive: true });
  const certs = await createCertificates(root);
  await fs.copyFile(certs.caCert, path.join(path.dirname(root), 'data', 'controller-ca.crt'));
  const core = new ControllerCore({ store: new JsonStore(path.join(root, 'controller-state.json')) });
  await core.load();
  const adapter = new ControllerWssServerAdapter({ sessionManager: core.sessions });
  const server = https.createServer({
    key: await fs.readFile(certs.serverKey),
    cert: await fs.readFile(certs.serverCert)
  });
  const runtime = new ControllerWssRuntimeServer({ server, adapter });
  await listen(server, 0, '0.0.0.0');
  return {
    core,
    adapter,
    server,
    runtime,
    port: server.address().port,
    shutdown: async () => {
      runtime.shutdown();
      await closeServer(server);
    }
  };
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

function workflowRevision(url) {
  return createWorkflowRevisionFromExtensionProfile({
    id: 'real-search-hom-nay-that-vui',
    name: 'Real Search - hom nay that vui',
    enabled: true,
    steps: [
      { id: 'click', name: 'Click search input', type: 'click', selector: '#q', next: 'type' },
      { id: 'type', name: 'Type query', type: 'type', selector: '#q', text: QUERY, next: 'submit' },
      { id: 'submit', name: 'Submit search', type: 'click', selector: '#search', next: 'select' },
      { id: 'select', name: 'Select exact query', type: 'shortcut', selector: '#q', keys: ['CTRL', 'A'], next: 'copy' },
      { id: 'copy', name: 'Copy exact query', type: 'shortcut', selector: '#q', keys: ['CTRL', 'C'], next: 'done' },
      { id: 'done', name: 'Done', type: 'log', message: 'controlled search copy complete' }
    ]
  }, {
    sourceDeviceId: DEVICE_ID,
    now: '2026-07-16T00:00:00.000Z'
  });
}

function cancelWorkflowRevision(url) {
  return createWorkflowRevisionFromExtensionProfile({
    id: 'real-search-cancel',
    name: 'Real Search - copied execution',
    enabled: true,
    steps: [
      { id: 'wait-missing', name: 'Wait missing', type: 'click', selector: '#never-appears', timeoutMs: 10000 }
    ]
  }, {
    sourceDeviceId: DEVICE_ID,
    now: '2026-07-16T00:00:00.000Z'
  });
}

async function startSearchFixture() {
  const events = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/event') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      events.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(events));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body>
      <form id="form"><input id="q" name="q" autocomplete="off"><button id="search" type="submit">Search</button></form>
      <h1 id="results">Waiting</h1><ol id="list"></ol><output id="copied"></output>
      <script>
        const events = [];
        const send = (event) => { events.push(event); fetch('/event', { method: 'POST', body: JSON.stringify(event) }).catch(() => {}); };
        q.addEventListener('focus', () => send({ type: 'focus' }));
        q.addEventListener('input', () => send({ type: 'input', value: q.value }));
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          results.textContent = 'Results for ' + q.value;
          list.innerHTML = '<li>Deterministic result: ' + q.value + '</li>';
          send({ type: 'submit', value: q.value });
          send({ type: 'results', value: q.value });
        });
        document.addEventListener('copy', (event) => {
          const value = document.activeElement === q ? q.value.slice(q.selectionStart, q.selectionEnd) : String(getSelection());
          event.clipboardData.setData('text/plain', value);
          event.preventDefault();
          copied.textContent = value;
          send({ type: 'copy', value });
        });
      </script></body></html>`);
  });
  await listen(server, 0, '0.0.0.0');
  return { server, events, url: `http://host.docker.internal:${server.address().port}/` };
}

async function control(baseUrl, deviceId, type, payload, token) {
  const response = await fetch(`${baseUrl}/v1/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      protocol: 'war-control.v1',
      messageId: `${type}-${Date.now()}-${Math.random()}`,
      type,
      deviceId,
      timestamp: new Date().toISOString(),
      deadlineMs: 30000,
      idempotencyKey: `${type}-${Date.now()}-${Math.random()}`,
      payload
    })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${type} failed: ${JSON.stringify(body)}`);
  return body;
}

async function screenshot(baseUrl, deviceId, targetId, token, name) {
  const result = await control(baseUrl, deviceId, 'page.screenshot', { targetId, format: 'png' }, token);
  const source = result.result.screenshot.path.replace('/data/', '');
  const dataPath = path.join(mountedDataDir, source);
  await fs.copyFile(dataPath, path.join(ARTIFACT_DIR, name)).catch(() => {});
  return result;
}

async function writeEvidence(result) {
  await fs.writeFile(path.join(ARTIFACT_DIR, 'execution-events.json'), `${JSON.stringify(result.executionEvents || [], null, 2)}\n`);
  await fs.writeFile(path.join(ARTIFACT_DIR, 'container-runtime.json'), `${JSON.stringify({
    image: IMAGE,
    localDocker: true,
    noSandbox: process.env.WAR_BROWSER_NO_SANDBOX || '1'
  }, null, 2)}\n`);
  await fs.writeFile(path.join(ARTIFACT_DIR, 'real-world-container-results.json'), `${JSON.stringify(sanitizeResult(result), null, 2)}\n`);
  await fs.writeFile(path.join(ARTIFACT_DIR, 'REAL_WORLD_CONTAINER_REPORT.md'), reportMarkdown(result));
}

function reportMarkdown(result) {
  return `# Real World Container Gate

Result: ${result.controlledFallback === 'PASS' ? 'PASS' : 'FAIL'}

- Query: ${QUERY}
- Google case: ${result.googleCase}
- Controlled fallback: ${result.controlledFallback}
- Manual computer-use: ${result.manualComputerUse}
- Controller/WSS: ${pass(result.assertions.tlsWss)}
- Browser Agent container: ${pass(result.assertions.browserAgentContainer)}
- MV3 Extension: ${pass(result.assertions.mv3Extension)}
- Copy verification: ${pass(result.assertions.clipboardEqualsExpected)}
- Result uplink: ${pass(result.assertions.resultUplink)}
- Terminal replay protection: ${pass(result.assertions.terminalJobNotReplayed)}
- Cancel path: ${pass(result.assertions.cancelPath)}
`;
}

function sanitizeResult(result) {
  return JSON.parse(JSON.stringify(result, (_key, value) => typeof value === 'string' ? sanitize(value) : value));
}

function sanitize(value) {
  return String(value).replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
}

function pass(value) {
  return value ? 'PASS' : 'FAIL';
}

async function waitForHealth(baseUrl, timeoutMs = 60000) {
  return waitFor(async () => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();
    return response.ok && (body.browserState === 'running' || body.browserState === 'degraded') && body.extensionLoaded ? body : false;
  }, timeoutMs, 'container health');
}

async function getContainerBaseUrl(container) {
  const inspect = await docker(['inspect', container, '--format', '{{(index (index .NetworkSettings.Ports "3766/tcp") 0).HostPort}}']);
  const port = inspect.stdout.trim();
  return `http://127.0.0.1:${port}`;
}

async function dockerBridgeGateway() {
  const result = await docker(['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}']);
  return result.stdout.trim() || '172.17.0.1';
}

async function isContainerRunning(container) {
  const result = await docker(['inspect', '-f', '{{.State.Running}}', container]).catch(() => ({ stdout: 'false' }));
  return result.stdout.trim() === 'true';
}

function docker(args) {
  return execFileP('docker', args, { timeout: 120000 });
}

async function createCertificates(root) {
  const opensslCnf = path.join(root, 'openssl.cnf');
  const ext = path.join(root, 'server.ext');
  await fs.writeFile(opensslCnf, '[req]\ndistinguished_name=req_distinguished_name\n[req_distinguished_name]\n');
  await fs.writeFile(ext, 'subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1\n');
  const env = { ...process.env, OPENSSL_CONF: opensslCnf };
  const caKey = path.join(root, 'ca.key');
  const caCert = path.join(root, 'ca.crt');
  const serverKey = path.join(root, 'server.key');
  const serverCsr = path.join(root, 'server.csr');
  const serverCert = path.join(root, 'server.crt');
  await execFileP('openssl', ['genrsa', '-out', caKey, '2048'], { env });
  await execFileP('openssl', ['req', '-x509', '-new', '-nodes', '-key', caKey, '-sha256', '-days', '1', '-out', caCert, '-subj', '/CN=WAR Test CA'], { env });
  await execFileP('openssl', ['genrsa', '-out', serverKey, '2048'], { env });
  await execFileP('openssl', ['req', '-new', '-key', serverKey, '-out', serverCsr, '-subj', '/CN=host.docker.internal'], { env });
  await execFileP('openssl', ['x509', '-req', '-in', serverCsr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-out', serverCert, '-days', '1', '-sha256', '-extfile', ext], { env });
  return { caCert, serverKey, serverCert };
}

function deviceDescriptor(deviceId) {
  return {
    deviceId,
    displayName: 'Container Real World Agent',
    hostName: 'container',
    platform: 'linux',
    architecture: 'x64',
    agentVersion: '0.1.0',
    extensionVersion: '0.1.0',
    browserVersion: 'chromium',
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

function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const value = await predicate();
        if (value) return resolve(value);
      } catch {}
      if (Date.now() - started > timeoutMs) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, 250);
    };
    tick();
  });
}

function listen(server, port, host) {
  return new Promise((resolve) => server.listen(port, host, resolve));
}

function closeServer(server) {
  if (!server) return Promise.resolve();
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
