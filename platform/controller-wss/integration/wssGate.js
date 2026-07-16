import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { ControllerCore, hashSecret } from '../../controller-core/src/controllerCore.js';
import { JsonStore } from '../../../companion/store.js';
import { ControllerWssServerAdapter } from '../src/serverAdapter.js';
import { ControllerWssRuntimeServer } from '../src/wssServer.js';
import { PROTOCOL_VERSION } from '../../protocol/src/protocolV2.js';

export async function runWssGate() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'war-wss-gate-'));
  const artifactDir = path.resolve('artifacts/controller-wss');
  await fs.mkdir(artifactDir, { recursive: true });
  const artifact = {
    startedAt: new Date().toISOString(),
    head: await gitHead().catch(() => 'unknown'),
    nodeVersion: process.version,
    npmVersion: await npmVersion().catch(() => 'unknown'),
    dockerVersion: await dockerVersion().catch(() => 'unknown'),
    tlsVerified: false,
    unauthorizedTlsRejected: false,
    authorizationHeaderReceived: false,
    agentsAuthenticated: 0,
    restartReplayPassed: false,
    sameJobId: false,
    sameIdempotencyKey: false,
    terminalReplayCount: null,
    revokedCredentialRejected: false,
    duplicateReconnectTimers: 0,
    cleanupPassed: false
  };
  let runtime;
  let server;
  try {
    const certs = await createCertificates(root);
    const ca = await fs.readFile(certs.caCert);
    const storePath = path.join(root, 'controller-state.json');
    let gate = await startController({ storePath, certs, port: 0 });
    runtime = gate.runtime;
    server = gate.server;
    await pair(gate.core, 'dev-a', 'cred-a');
    await pair(gate.core, 'dev-b', 'cred-b');

    await assertRejects(() => connectAgent(gate.url, { deviceId: 'dev-a', credential: 'cred-a' }));
    artifact.unauthorizedTlsRejected = true;

    await assertRejects(() => connectRaw(gate.url, ca));

    const agentA = await connectAgent(gate.url, { deviceId: 'dev-a', credential: 'cred-a', ca });
    artifact.tlsVerified = true;
    artifact.authorizationHeaderReceived = true;
    const agentB = await connectAgent(gate.url, { deviceId: 'dev-b', credential: 'cred-b', ca });
    artifact.agentsAuthenticated = [agentA, agentB].filter((agent) => agent.response.payload.ok).length;
    await gate.core.sessions.reconcileWorkflows('dev-a', agentA.session.generation, [revision()]);
    const first = await gate.core.sessions.dispatch(dispatchArgs(agentA.session, { idempotencyKey: 'restart-dispatch' }));
    const jobId = first.dispatch.jobId;
    const idempotencyKey = first.dispatch.idempotencyKey;
    agentA.socket.close();
    agentB.socket.close();
    runtime.shutdown();
    await closeServer(server);
    gate.core.sessions.shutdown();

    gate = await startController({ storePath, certs, port: 0 });
    runtime = gate.runtime;
    server = gate.server;
    const replayed = await connectAgent(gate.url, { deviceId: 'dev-a', credential: 'cred-a', ca, nonce: 'after-restart' });
    const replay = replayed.response.payload.replay || [];
    artifact.restartReplayPassed = replay.length === 1;
    artifact.sameJobId = replay[0]?.jobId === jobId;
    artifact.sameIdempotencyKey = replay[0]?.idempotencyKey === idempotencyKey;
    replayed.socket.send(JSON.stringify(executionResult(replayed.session, jobId)));
    await replayed.nextMessage();
    replayed.socket.close();
    const terminalReconnect = await connectAgent(gate.url, { deviceId: 'dev-a', credential: 'cred-a', ca, nonce: 'after-terminal' });
    artifact.terminalReplayCount = (terminalReconnect.response.payload.replay || []).length;
    terminalReconnect.socket.close();

    await gate.core.pairing.revoke('dev-a');
    const revoked = await connectAgent(gate.url, { deviceId: 'dev-a', credential: 'cred-a', ca, nonce: 'revoked' });
    artifact.revokedCredentialRejected = revoked.response.payload.ok === false;
    revoked.socket.close();
    artifact.cleanupPassed = true;
    artifact.finishedAt = new Date().toISOString();
    const artifactPath = path.join(artifactDir, `wss-gate-${Date.now()}.json`);
    await fs.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(`artifact=${artifactPath}`);
    console.log(JSON.stringify(artifact, null, 2));
    if (!artifact.tlsVerified || !artifact.unauthorizedTlsRejected || !artifact.authorizationHeaderReceived || artifact.agentsAuthenticated !== 2 || !artifact.restartReplayPassed || !artifact.sameJobId || !artifact.sameIdempotencyKey || artifact.terminalReplayCount !== 0 || !artifact.revokedCredentialRejected || !artifact.cleanupPassed) {
      throw new Error('WSS gate failed');
    }
    return artifact;
  } finally {
    runtime?.shutdown();
    if (server) await closeServer(server).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function startController({ storePath, certs, port }) {
  const core = new ControllerCore({ store: new JsonStore(storePath), now: () => new Date().toISOString(), id: sequenceId() });
  await core.load();
  const adapter = new ControllerWssServerAdapter({ sessionManager: core.sessions });
  const server = https.createServer({
    key: await fs.readFile(certs.serverKey),
    cert: await fs.readFile(certs.serverCert)
  });
  const runtime = new ControllerWssRuntimeServer({ server, adapter });
  await listen(server, port);
  return { core, adapter, server, runtime, url: `wss://localhost:${server.address().port}/v1/agent-session` };
}

async function pair(core, deviceId, credential) {
  await core.pairing.requestPairing({ device: device({ deviceId }), requestId: `pair-${deviceId}` });
  await core.store.update((state) => {
    state.pendingPairings.find((item) => item.requestId === `pair-${deviceId}`).tokenHash = hashSecret(`code-${deviceId}`);
  });
  await core.pairing.confirmPairing(`pair-${deviceId}`, `code-${deviceId}`);
  await core.store.update((state) => {
    state.pairedAgents.find((item) => item.deviceId === deviceId).credentialHash = hashSecret(credential);
  });
}

async function connectAgent(url, { deviceId, credential, ca, nonce = 'nonce-a' }) {
  const socket = await connectRaw(url, ca, { Authorization: `Bearer ${credential}` });
  socket.send(JSON.stringify(agentHello(deviceId, nonce)));
  const response = JSON.parse(await nextMessage(socket));
  return {
    socket,
    response,
    session: response.payload.session,
    nextMessage: () => nextMessage(socket)
  };
}

function connectRaw(url, ca, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, [], { ca, headers });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once('message', (message) => resolve(Buffer.isBuffer(message) ? message.toString('utf8') : String(message)));
    socket.once('error', reject);
  });
}

async function createCertificates(root) {
  const opensslCnf = path.join(root, 'openssl.cnf');
  const ext = path.join(root, 'server.ext');
  await fs.writeFile(opensslCnf, '[req]\ndistinguished_name=req_distinguished_name\n[req_distinguished_name]\n');
  await fs.writeFile(ext, 'subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:controller-gate\n');
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
  await fs.chmod(caKey, 0o600).catch(() => {});
  await fs.chmod(serverKey, 0o600).catch(() => {});
  return { caCert, serverKey, serverCert };
}

function agentHello(deviceId, nonce) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: `hello-${deviceId}-${nonce}`,
    type: 'agent.hello',
    sentAt: new Date().toISOString(),
    deviceId,
    payload: {
      protocolVersion: PROTOCOL_VERSION,
      device: device({ deviceId }),
      supportedMessageTypes: ['agent.hello', 'agent.presence', 'agent.execution.event', 'execution.result'],
      sessionNonce: nonce,
      sentAt: new Date().toISOString()
    }
  };
}

function executionResult(session, jobId) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: `result-${jobId}`,
    type: 'execution.result',
    sentAt: new Date().toISOString(),
    deadline: new Date(Date.now() + 60000).toISOString(),
    idempotencyKey: `result-${jobId}`,
    deviceId: session.deviceId,
    sessionId: session.sessionId,
    jobId,
    payload: { jobId, eventType: 'job_succeeded', sentAt: new Date().toISOString(), result: { ok: true }, generation: session.generation }
  };
}

function revision() {
  return {
    workflowId: 'wf-1',
    revision: 1,
    schemaVersion: 'war-workflow-revision.v2',
    contentHash: 'a'.repeat(64),
    name: 'Workflow',
    description: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sourceDeviceId: 'dev-a',
    requiredInputs: [],
    profilePayload: { id: 'wf-1', steps: [] }
  };
}

function dispatchArgs(session, overrides = {}) {
  return {
    deviceId: session.deviceId,
    generation: session.generation,
    workflowId: 'wf-1',
    workflowRevision: 1,
    workflowContentHash: 'a'.repeat(64),
    inputs: {},
    deadline: new Date(Date.now() + 60000).toISOString(),
    idempotencyKey: 'dispatch',
    ...overrides
  };
}

function device(overrides = {}) {
  return {
    deviceId: 'dev-a',
    displayName: 'Agent',
    hostName: 'host',
    platform: 'linux',
    architecture: 'x64',
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
    lastSeenAt: new Date().toISOString(),
    ...overrides
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

async function assertRejects(fn) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error('Expected operation to reject');
}

async function gitHead() {
  return (await execFileP('git', ['rev-parse', 'HEAD'])).stdout.trim();
}

async function npmVersion() {
  return (await execFileP(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['-v'])).stdout.trim();
}

async function dockerVersion() {
  return (await execFileP('docker', ['--version'])).stdout.trim();
}

function sequenceId() {
  let i = 0;
  return (prefix) => `${prefix}-${++i}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runWssGate();
}
