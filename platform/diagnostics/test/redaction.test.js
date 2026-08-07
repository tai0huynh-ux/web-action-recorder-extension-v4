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

test('quoted and angle-delimited inline secrets are redacted', () => {
  const secrets = ['quoted-auth-secret', 'quoted-identity-secret', 'angle-token-secret'];
  const redacted = redactDiagnostic(new Error(`authorization="${secrets[0]}" identity='${secrets[1]}' token=<${secrets[2]}>`));
  const encoded = JSON.stringify(redacted);

  for (const secret of secrets) assert.equal(encoded.includes(secret), false, `diagnostic leaks ${secret}`);
});

test('quoted and angle-delimited Bearer credentials are redacted', () => {
  const secrets = [
    'double-quoted-bearer-secret',
    'single-quoted-bearer-secret',
    'angle-bearer-secret',
    'authorization-bearer-secret',
  ];
  const redacted = redactDiagnostic(new Error(
    `Bearer "${secrets[0]}" Bearer '${secrets[1]}' Bearer <${secrets[2]}> Authorization: Bearer "${secrets[3]}"`,
  ));
  const encoded = JSON.stringify(redacted);

  for (const secret of secrets) assert.equal(encoded.includes(secret), false, `diagnostic leaks ${secret}`);
});

test('inline authorization headers redact complete Basic and Digest values', () => {
  const secrets = [
    'basic-authorization-secret',
    'proxy-basic-authorization-secret',
    'digest-username-secret',
    'digest-response-secret',
    'lowercase-angle-authorization-secret',
    'structured-basic-authorization-secret',
    'command-line-basic-authorization-secret',
  ];
  const redacted = redactDiagnostic({
    error: new Error([
      `Authorization: Basic ${secrets[0]}`,
      `Proxy-Authorization: basic "${secrets[1]}"`,
      `AUTHORIZATION: Digest username="${secrets[2]}", response="${secrets[3]}"`,
      `authorization:basic <${secrets[4]}>`,
      'safe next line',
    ].join('\n')),
    message: `request failed with Authorization: Basic ${secrets[5]}`,
    commandLine: ['curl', '-H', `Authorization: Basic ${secrets[6]}`],
  });
  const encoded = JSON.stringify(redacted);

  for (const secret of secrets) assert.equal(encoded.includes(secret), false, `diagnostic leaks ${secret}`);
  assert.match(redacted.error.message, /safe next line/);
});

test('escaped and unterminated inline secret delimiters do not leak a suffix', () => {
  const secrets = [
    'escaped-double-tail',
    'escaped-single-tail',
    'unterminated-double-secret',
    'unterminated-single-secret',
    'unterminated-angle-secret',
  ];
  const redacted = redactDiagnostic(new Error(
    `token="first\\\"${secrets[0]}" identity='first\\'${secrets[1]}' authorization="${secrets[2]} token='${secrets[3]} identity=<${secrets[4]}`,
  ));
  const encoded = JSON.stringify(redacted);

  for (const secret of secrets) assert.equal(encoded.includes(secret), false, `diagnostic leaks ${secret}`);
});

test('WebSocket URLs do not leak query credentials', () => {
  const redacted = redactUrl(`wss://controller.example/v1/agent-session?credential=${SENTINELS[0]}&device=dev-a`);
  assert.equal(redacted.includes(SENTINELS[0]), false);
  assert.match(redacted, /device=dev-a/);
});

test('URL fragments are removed fail-closed', () => {
  const redacted = redactUrl(`https://controller.example/callback?device=dev-a#access_token=${SENTINELS[1]}&state=visible`);

  assert.equal(redacted.includes(SENTINELS[1]), false);
  assert.equal(redacted.includes('#'), false);
  assert.match(redacted, /device=dev-a/);
});

test('URL-suffixed structured fields preserve safe query values', () => {
  const redacted = redactDiagnostic({
    controllerWssUrl: `wss://controller.example/v1/agent-session?credential=${SENTINELS[0]}&device=dev-a`,
    callbackURL: `https://controller.example/callback?token=${SENTINELS[1]}&mode=test`,
  });
  const encoded = JSON.stringify(redacted);

  assert.equal(encoded.includes(SENTINELS[0]), false);
  assert.equal(encoded.includes(SENTINELS[1]), false);
  assert.match(redacted.controllerWssUrl, /device=dev-a/);
  assert.match(redacted.callbackURL, /mode=test/);
});

test('API and access key variants are redacted across diagnostic surfaces', () => {
  const apiKey = 'synthetic-api-key-secret';
  const accessKey = 'synthetic-access-key-secret';
  const redacted = redactDiagnostic({
    apiKey,
    nested: { access_key: accessKey },
    callbackURL: `https://controller.example/callback?api_key=${apiKey}&device=dev-a`,
    controllerWssUrl: `wss://controller.example/v1/agent-session?access_key=${accessKey}&mode=test`,
    commandLine: ['agent', '--api-key', apiKey, `--access_key=${accessKey}`],
    error: new Error(`api_key=${apiKey} accessKey='${accessKey}'`),
  });
  const encoded = JSON.stringify(redacted);

  assert.equal(encoded.includes(apiKey), false);
  assert.equal(encoded.includes(accessKey), false);
  assert.match(redacted.callbackURL, /device=dev-a/);
  assert.match(redacted.controllerWssUrl, /mode=test/);
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

test('Windows slash command arguments do not expose secret values', () => {
  const secrets = ['slash-next-secret', 'slash-colon-secret', 'slash-equals-secret'];
  const redacted = redactCommandLine([
    'agent.exe',
    '/api-key',
    secrets[0],
    `/access-key:${secrets[1]}`,
    `/api_key=${secrets[2]}`,
    '/host',
    '127.0.0.1',
  ]);
  const encoded = JSON.stringify(redacted);

  for (const secret of secrets) assert.equal(encoded.includes(secret), false, `command line leaks ${secret}`);
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
