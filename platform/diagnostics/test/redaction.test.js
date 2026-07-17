import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dockerContainerDiagnostic,
  redactCommandLine,
  redactDiagnostic,
  redactEnvironment,
  redactHeaders,
  redactUrl
} from '../src/redaction.js';

const SENTINELS = [
  'synthetic-controller-credential',
  'synthetic-agent-token',
  'synthetic-bootstrap-secret',
  'synthetic-vnc-password',
  'synthetic-pairing-code',
  'synthetic-cookie-value'
];

test('nested credential fields and environment-like objects are redacted', () => {
  const redacted = redactDiagnostic({
    safe: 'visible',
    nested: {
      sessionCredential: SENTINELS[0],
      env: {
        WAR_AGENT_TOKEN: SENTINELS[1],
        WAR_VNC_PASSWORD: SENTINELS[3],
        WAR_AGENT_HOST: '127.0.0.1'
      }
    }
  });
  const encoded = JSON.stringify(redacted);
  for (const value of SENTINELS.slice(0, 4)) assert.equal(encoded.includes(value), false);
  assert.equal(redacted.safe, 'visible');
  assert.equal(redacted.nested.env.WAR_AGENT_HOST, '127.0.0.1');
});

test('authorization headers and cookies are redacted', () => {
  const redacted = redactHeaders({
    Authorization: `Bearer ${SENTINELS[1]}`,
    Cookie: `session=${SENTINELS[5]}`,
    'content-type': 'application/json'
  });
  const encoded = JSON.stringify(redacted);
  assert.equal(encoded.includes(SENTINELS[1]), false);
  assert.equal(encoded.includes(SENTINELS[5]), false);
  assert.equal(redacted['content-type'], 'application/json');
});

test('WebSocket URLs do not leak query credentials', () => {
  const redacted = redactUrl(`wss://controller.example/v1/agent-session?credential=${SENTINELS[0]}&device=dev-a`);
  assert.equal(redacted.includes(SENTINELS[0]), false);
  assert.match(redacted, /device=dev-a/);
});

test('process command lines do not expose secret arguments', () => {
  const redacted = redactCommandLine([
    'node',
    'agent.js',
    '--session-credential',
    SENTINELS[0],
    `--bootstrap-token=${SENTINELS[2]}`,
    '--host',
    '127.0.0.1'
  ]);
  const encoded = JSON.stringify(redacted);
  assert.equal(encoded.includes(SENTINELS[0]), false);
  assert.equal(encoded.includes(SENTINELS[2]), false);
  assert.ok(encoded.includes('127.0.0.1'));
});

test('Docker diagnostic output uses an allowlist', () => {
  const diagnostic = dockerContainerDiagnostic({
    Id: '1234567890abcdef',
    Name: '/war-lan-pilot-agent',
    Config: {
      Image: 'war-browser-agent:test',
      User: 'war',
      Env: [`WAR_AGENT_TOKEN=${SENTINELS[1]}`],
      Labels: { 'managed-by': 'war-lan-pilot', secret: SENTINELS[2] }
    },
    HostConfig: {
      Privileged: false,
      NetworkMode: 'bridge',
      Binds: [`/tmp/${SENTINELS[2]}:/data:rw`]
    },
    NetworkSettings: {
      Ports: {
        '3766/tcp': [{ HostIp: '127.0.0.1', HostPort: '32771' }]
      }
    }
  });
  const encoded = JSON.stringify(diagnostic);
  assert.equal(encoded.includes(SENTINELS[1]), false);
  assert.equal(encoded.includes(SENTINELS[2]), false);
  assert.equal(diagnostic.labels['managed-by'], 'war-lan-pilot');
  assert.equal(diagnostic.hostConfig.privileged, false);
});

test('pairing code is not included in reports', () => {
  const report = redactDiagnostic({
    pairingCode: SENTINELS[4],
    pairing: { requestId: 'pair-a', expiresAt: '2026-07-17T00:00:00.000Z' }
  });
  const encoded = JSON.stringify(report);
  assert.equal(encoded.includes(SENTINELS[4]), false);
  assert.equal(report.pairing.requestId, 'pair-a');
});

test('environment helper preserves non-secret fields', () => {
  const env = redactEnvironment({
    WAR_AGENT_TOKEN: SENTINELS[1],
    WAR_BROWSER_WIDTH: '1366'
  });
  assert.equal(env.WAR_AGENT_TOKEN, '<redacted>');
  assert.equal(env.WAR_BROWSER_WIDTH, '1366');
});

test('Error objects are serialized safely without leaking custom secret details', () => {
  const error = new Error(`failed with token=${SENTINELS[1]}`);
  error.code = 'CONFIG_FAILED';
  error.status = 500;
  error.details = {
    url: `https://controller.example/start?accessToken=${SENTINELS[1]}&mode=test`,
    nested: [{ vncPassword: SENTINELS[3] }]
  };
  const redacted = redactDiagnostic(error);
  const encoded = JSON.stringify(redacted);
  assert.equal(encoded.includes(SENTINELS[1]), false);
  assert.equal(encoded.includes(SENTINELS[3]), false);
  assert.equal(encoded.includes('stack'), false);
  assert.equal(redacted.code, 'CONFIG_FAILED');
  assert.equal(redacted.status, 500);
  assert.match(redacted.message, /<redacted>/);
});

test('redaction does not mutate source objects', () => {
  const source = {
    safe: 'visible',
    nested: {
      accessToken: SENTINELS[1],
      list: [{ cookie: SENTINELS[5] }]
    }
  };
  const redacted = redactDiagnostic(source);
  assert.equal(redacted.nested.accessToken, '<redacted>');
  assert.equal(source.nested.accessToken, SENTINELS[1]);
  assert.equal(source.nested.list[0].cookie, SENTINELS[5]);
});
