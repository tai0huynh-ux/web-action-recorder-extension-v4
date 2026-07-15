import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const IMAGE = 'war-browser-agent:phase1';
const CONTROL_PORT = '3766/tcp';
const ARTIFACT_DIR = path.resolve('artifacts/browser-agent');

export async function runContainerSmoke({ keepArtifact = true } = {}) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const fixture = await startFixture();
  const suffix = `${Date.now()}-${process.pid}`;
  const container = `war-browser-agent-smoke-${suffix}`;
  const volume = `war-browser-agent-smoke-data-${suffix}`;
  const artifact = {
    mode: 'smoke',
    startedAt: new Date().toISOString(),
    fixturePort: fixture.port,
    commands: [],
    persistence: {},
    cleanup: {}
  };
  try {
    const token = crypto.randomBytes(24).toString('hex');
    const allow = await dockerBridgeGateway();
    await docker(['volume', 'create', volume]);
    const start = performance.now();
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
      '-e', 'WAR_BROWSER_NO_SANDBOX=1',
      '-v', `${volume}:/data`,
      IMAGE
    ]);
    let baseUrl = await getContainerBaseUrl(container);
    const health = await waitForHealth(baseUrl);
    artifact.browserReadyMs = Math.round(performance.now() - start);
    artifact.initialHealth = health;
    assert(health.extensionLoaded, `extension not loaded: ${JSON.stringify(health)}`);
    const state = await control(baseUrl, health.deviceId, 'browser.getState', {}, token);
    artifact.extension = state.result.extension;
    assert(state.result.extension.loaded, 'browser.getState did not report loaded extension');
    artifact.processes = await docker(['exec', container, 'sh', '-c', "pgrep -af 'chromium|Xvfb'"]);
    assert(/chromium/i.test(artifact.processes.stdout), 'Chromium process was not found');
    assert(/Xvfb/i.test(artifact.processes.stdout), 'Xvfb process was not found');

    const fixtureA = `http://host.docker.internal:${fixture.port}/fixture-a`;
    const fixtureB = `http://host.docker.internal:${fixture.port}/fixture-b`;
    const opened = await timedCommand(artifact, baseUrl, health.deviceId, 'tab.open', { url: fixtureA }, token);
    const firstTabId = opened.result.tab.targetId;
    const duplicate = await timedCommand(artifact, baseUrl, health.deviceId, 'tab.open', { url: fixtureA }, token);
    assert.notEqual(firstTabId, duplicate.result.tab.targetId, 'two tabs with same URL reused targetId');
    const listed = await timedCommand(artifact, baseUrl, health.deviceId, 'tab.list', {}, token);
    assert(listed.result.tabs.some((tab) => tab.targetId === firstTabId && tab.url.includes('/fixture-a')), 'opened fixture tab was not listed');
    await timedCommand(artifact, baseUrl, health.deviceId, 'tab.activate', { targetId: firstTabId }, token);
    const activeList = await timedCommand(artifact, baseUrl, health.deviceId, 'tab.list', {}, token);
    assert.equal(activeList.result.tabs.filter((tab) => tab.active).length, 1, 'tab.list must have exactly one active tab');
    const navigated = await timedCommand(artifact, baseUrl, health.deviceId, 'tab.navigate', { targetId: firstTabId, url: fixtureB }, token);
    assert.equal(navigated.result.tab.targetId, firstTabId, 'navigate changed targetId');
    await timedCommand(artifact, baseUrl, health.deviceId, 'tab.close', { targetId: duplicate.result.tab.targetId }, token);

    const marker = `marker-${suffix}`;
    await timedCommand(artifact, baseUrl, health.deviceId, 'tab.navigate', {
      targetId: firstTabId,
      url: `http://host.docker.internal:${fixture.port}/set-cookie?marker=${marker}`
    }, token);
    await timedCommand(artifact, baseUrl, health.deviceId, 'browser.restart', {}, token);
    const afterBrowserRestart = await waitForHealth(baseUrl);
    assert.equal(afterBrowserRestart.deviceId, health.deviceId, 'deviceId changed after browser restart');
    await timedCommand(artifact, baseUrl, health.deviceId, 'tab.open', {
      url: `http://host.docker.internal:${fixture.port}/echo-cookie`
    }, token);
    assert(fixture.seenCookies.some((cookie) => cookie.includes(marker)), 'profile cookie marker missing after browser restart');

    await docker(['restart', container]);
    baseUrl = await getContainerBaseUrl(container);
    const afterContainerRestart = await waitForHealth(baseUrl);
    assert.equal(afterContainerRestart.deviceId, health.deviceId, 'deviceId changed after container restart');
    await timedCommand(artifact, baseUrl, health.deviceId, 'tab.open', {
      url: `http://host.docker.internal:${fixture.port}/echo-cookie`
    }, token);
    assert(fixture.seenCookies.some((cookie) => cookie.includes(marker)), 'profile cookie marker missing after container restart');
    artifact.persistence = {
      deviceIdBefore: health.deviceId,
      deviceIdAfterContainerRestart: afterContainerRestart.deviceId,
      markerSeenCount: fixture.seenCookies.filter((cookie) => cookie.includes(marker)).length
    };
    artifact.versions = await collectVersions(container);
    return artifact;
  } finally {
    fixture.close();
    await docker(['rm', '-f', container]).catch(() => {});
    await docker(['volume', 'rm', '-f', volume]).catch(() => {});
    artifact.cleanup.containerRunning = await isContainerRunning(container);
    artifact.finishedAt = new Date().toISOString();
    if (keepArtifact) writeArtifact('smoke', artifact);
  }
}

export async function runPhase2ContainerSmoke({ keepArtifact = true, mode = 'phase2-smoke' } = {}) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const fixture = await startFixture();
  const suffix = `${Date.now()}-${process.pid}`;
  const container = `war-browser-agent-phase2-${suffix}`;
  const volume = `war-browser-agent-phase2-data-${suffix}`;
  const artifact = {
    mode,
    startedAt: new Date().toISOString(),
    fixturePort: fixture.port,
    commands: [],
    performance: {},
    cleanup: {}
  };
  try {
    const token = crypto.randomBytes(24).toString('hex');
    const allow = await dockerBridgeGateway();
    await docker(['volume', 'create', volume]);
    const started = performance.now();
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
      '-e', 'WAR_BROWSER_NO_SANDBOX=1',
      '-v', `${volume}:/data`,
      IMAGE
    ]);
    const baseUrl = await getContainerBaseUrl(container);
    const health = await waitForHealth(baseUrl);
    artifact.browserReadyMs = Math.round(performance.now() - started);
    artifact.initialHealth = health;
    await docker(['exec', container, 'sh', '-c', "printf 'upload-ok' > /data/uploads/local.txt"]);
    const state = await control(baseUrl, health.deviceId, 'browser.getState', {}, token);
    artifact.extension = state.result.extension;
    artifact.versions = await collectVersions(container);

    const fixtureUrl = `http://host.docker.internal:${fixture.port}/phase2`;
    const opened = await timedCommand(artifact, baseUrl, health.deviceId, 'tab.open', { url: fixtureUrl }, token);
    const targetId = opened.result.tab.targetId;
    await timedCommand(artifact, baseUrl, health.deviceId, 'page.click', target(targetId, '#button'), token);
    if (artifact.mode === 'phase2-performance') {
      for (let index = 0; index < 99; index += 1) {
        await timedCommand(artifact, baseUrl, health.deviceId, 'page.click', target(targetId, '#button'), token);
      }
    }
    await timedCommand(artifact, baseUrl, health.deviceId, 'page.fill', { ...target(targetId, '#input'), value: 'redacted value' }, token);
    await timedCommand(artifact, baseUrl, health.deviceId, 'page.type', { ...target(targetId, '#textarea'), text: 'typed text' }, token);
    await timedCommand(artifact, baseUrl, health.deviceId, 'page.press', { ...target(targetId, '#textarea'), key: 'Enter' }, token);
    await timedCommand(artifact, baseUrl, health.deviceId, 'page.selectOption', { ...target(targetId, '#select'), option: { value: 'b' } }, token);
    await timedCommand(artifact, baseUrl, health.deviceId, 'page.check', target(targetId, '#check'), token);
    await timedCommand(artifact, baseUrl, health.deviceId, 'page.uncheck', target(targetId, '#check'), token);
    await timedCommand(artifact, baseUrl, health.deviceId, 'page.scroll', { targetId, deltaY: 500 }, token);
    await timedCommand(artifact, baseUrl, health.deviceId, 'page.click', target(targetId, '#show-delayed'), token);
    await timedCommand(artifact, baseUrl, health.deviceId, 'page.waitFor', { ...target(targetId, '#delayed'), state: 'visible', timeoutMs: 3000 }, token);
    await timedCommand(artifact, baseUrl, health.deviceId, 'page.getElementState', target(targetId, '#input'), token);
    await timedCommand(artifact, baseUrl, health.deviceId, 'page.listInteractiveElements', { targetId, limit: 20 }, token);
    await timedCommand(artifact, baseUrl, health.deviceId, 'page.uploadFile', { ...target(targetId, '#file'), files: [{ artifactId: 'local.txt' }] }, token);
    await timedCommand(artifact, baseUrl, health.deviceId, 'page.screenshot', { targetId, format: 'png' }, token);
    await timedCommand(artifact, baseUrl, health.deviceId, 'input.click', { space: 'viewport', x: 20, y: 20, button: 'left', clickCount: 1 }, token);
    if (artifact.mode === 'phase2-performance') {
      for (let index = 0; index < 99; index += 1) {
        await timedCommand(artifact, baseUrl, health.deviceId, 'input.click', { space: 'viewport', x: 20, y: 20, button: 'left', clickCount: 1 }, token);
      }
    }
    await timedCommand(artifact, baseUrl, health.deviceId, 'input.insertText', { space: 'viewport', text: 'raw text' }, token);
    await timedCommand(artifact, baseUrl, health.deviceId, 'browser.focusWindow', {}, token);
    await timedCommand(artifact, baseUrl, health.deviceId, 'input.click', { space: 'browser', x: 10, y: 10, button: 'left', clickCount: 1 }, token);
    if (artifact.mode === 'phase2-performance') {
      for (let index = 0; index < 199; index += 1) {
        await timedCommand(artifact, baseUrl, health.deviceId, 'input.click', { space: 'browser', x: 10, y: 10, button: 'left', clickCount: 1 }, token);
      }
      for (let index = 0; index < 200; index += 1) {
        await timedCommand(artifact, baseUrl, health.deviceId, 'input.keyDown', { space: 'browser', key: 'Enter' }, token);
        await timedCommand(artifact, baseUrl, health.deviceId, 'input.keyUp', { space: 'browser', key: 'Enter' }, token);
      }
    }
    await timedCommand(artifact, baseUrl, health.deviceId, 'input.shortcut', { space: 'viewport', keys: ['CTRL', 'L'] }, token);
    await timedCommand(artifact, baseUrl, health.deviceId, 'input.insertText', { space: 'viewport', text: fixtureUrl }, token);
    await timedCommand(artifact, baseUrl, health.deviceId, 'input.keyDown', { space: 'viewport', key: 'Enter' }, token);
    await timedCommand(artifact, baseUrl, health.deviceId, 'input.keyUp', { space: 'viewport', key: 'Enter' }, token);
    await sleep(500);
    await timedCommand(artifact, baseUrl, health.deviceId, 'browser.openInternalPage', { page: 'settings' }, token);
    await timedCommand(artifact, baseUrl, health.deviceId, 'browser.openInternalPage', { page: 'extensions' }, token);
    await timedCommand(artifact, baseUrl, health.deviceId, 'browser.openInternalPage', { page: 'extensionSidePanel' }, token);
    const stopStart = performance.now();
    await timedCommand(artifact, baseUrl, health.deviceId, 'input.stopAll', {}, token);
    artifact.stopAllLatencyMs = Math.round(performance.now() - stopStart);
    const inputState = await timedCommand(artifact, baseUrl, health.deviceId, 'input.getState', {}, token);
    assert.equal(inputState.result.heldKeys.length, 0, 'held keys remained after stopAll');
    assert.equal(inputState.result.heldButtons.length, 0, 'held buttons remained after stopAll');
    artifact.performance = summarizeCommandLatencies(artifact.commands);
    return artifact;
  } finally {
    fixture.close();
    await docker(['rm', '-f', container]).catch(() => {});
    await docker(['volume', 'rm', '-f', volume]).catch(() => {});
    artifact.cleanup.containerRunning = await isContainerRunning(container);
    artifact.finishedAt = new Date().toISOString();
    if (keepArtifact) writeArtifact('phase2-smoke', artifact);
  }
}

export async function runPhase2Performance({ gate = false } = {}) {
  const artifact = await runPhase2ContainerSmoke({ keepArtifact: false, mode: 'phase2-performance' });
  if (gate) assertPhase2PerformanceGate(artifact);
  writeArtifact('phase2-performance', artifact);
  return artifact;
}

export async function runTabSoak({ iterations = 100 } = {}) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const fixture = await startFixture();
  const suffix = `${Date.now()}-${process.pid}`;
  const container = `war-browser-agent-soak-${suffix}`;
  const volume = `war-browser-agent-soak-data-${suffix}`;
  const artifact = {
    mode: 'soak',
    iterations,
    startedAt: new Date().toISOString(),
    latenciesMs: [],
    errors: 0,
    timeouts: 0
  };
  try {
    const token = crypto.randomBytes(24).toString('hex');
    const allow = await dockerBridgeGateway();
    await docker(['volume', 'create', volume]);
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
      '-e', 'WAR_BROWSER_NO_SANDBOX=1',
      '-v', `${volume}:/data`,
      IMAGE
    ]);
    const baseUrl = await getContainerBaseUrl(container);
    const health = await waitForHealth(baseUrl);
    artifact.before = await collectRuntimeMetrics(container, baseUrl, health.deviceId, token);
    const fixtureUrl = `http://host.docker.internal:${fixture.port}/fixture-a`;
    for (let index = 0; index < iterations; index += 1) {
      const start = performance.now();
      try {
        const opened = await control(baseUrl, health.deviceId, 'tab.open', { url: `${fixtureUrl}?i=${index}` }, token);
        await control(baseUrl, health.deviceId, 'tab.list', {}, token);
        await control(baseUrl, health.deviceId, 'tab.close', { targetId: opened.result.tab.targetId }, token);
      } catch (error) {
        artifact.errors += 1;
        if (/timeout/i.test(error.message)) artifact.timeouts += 1;
        throw error;
      } finally {
        artifact.latenciesMs.push(Math.round(performance.now() - start));
      }
    }
    artifact.after = await collectRuntimeMetrics(container, baseUrl, health.deviceId, token);
    artifact.averageLatencyMs = average(artifact.latenciesMs);
    artifact.p95LatencyMs = percentile(artifact.latenciesMs, 0.95);
    assert(artifact.after.tabCount <= artifact.before.tabCount + 1, 'tab count did not return near baseline');
    assert(artifact.after.processCount <= artifact.before.processCount + 3, 'process count grew unexpectedly');
    return artifact;
  } finally {
    fixture.close();
    await docker(['rm', '-f', container]).catch(() => {});
    await docker(['volume', 'rm', '-f', volume]).catch(() => {});
    artifact.cleanup = { containerRunning: await isContainerRunning(container) };
    artifact.finishedAt = new Date().toISOString();
    writeArtifact('soak', artifact);
  }
}

async function timedCommand(artifact, baseUrl, deviceId, type, payload, token) {
  const start = performance.now();
  const result = await control(baseUrl, deviceId, type, payload, token);
  const backend = result.result?.backend;
  artifact.commands.push({
    type,
    backend,
    metric: backend ? `${type}:${backend}` : type,
    ms: result.durationMs ?? Math.round(performance.now() - start),
    outerMs: Math.round(performance.now() - start),
    status: result.status
  });
  return result;
}

async function control(baseUrl, deviceId, type, payload, token) {
  const response = await fetch(`${baseUrl}/v1/control`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
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

async function waitForHealth(baseUrl, timeoutMs = 45000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      const body = await response.json();
      if (response.ok && (body.browserState === 'running' || body.browserState === 'degraded')) return body;
      lastError = new Error(JSON.stringify(body));
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for health: ${lastError?.message}`);
}

async function getContainerBaseUrl(container) {
  for (let i = 0; i < 30; i += 1) {
    const result = await docker(['port', container, CONTROL_PORT]).catch(() => ({ stdout: '' }));
    const match = result.stdout.match(/127\.0\.0\.1:(\d+)/);
    if (match) return `http://127.0.0.1:${match[1]}`;
    await sleep(250);
  }
  throw new Error('container port was not published on 127.0.0.1');
}

async function collectVersions(container) {
  const [chromium, node, playwright] = await Promise.all([
    docker(['exec', container, 'chromium', '--version']),
    docker(['exec', container, 'node', '--version']),
    docker(['exec', container, 'node', '-p', "require('./node_modules/playwright-core/package.json').version"])
  ]);
  return {
    chromium: chromium.stdout.trim(),
    node: node.stdout.trim(),
    playwrightCore: playwright.stdout.trim()
  };
}

async function collectRuntimeMetrics(container, baseUrl, deviceId, token) {
  const [stats, processes, rss, tabs] = await Promise.all([
    docker(['stats', '--no-stream', '--format', '{{json .}}', container]),
    docker(['exec', container, 'sh', '-c', "pgrep -ac 'chromium|Xvfb|node' || true"]),
    docker(['exec', container, 'sh', '-c', "ps -eo rss=,comm= | awk '/chromium|node|Xvfb/ {sum[$2]+=$1} END {for (p in sum) print p,sum[p]}'"]),
    control(baseUrl, deviceId, 'tab.list', {}, token)
  ]);
  return {
    dockerStats: stats.stdout.trim(),
    processCount: Number(processes.stdout.trim() || 0),
    rssKbByProcess: rss.stdout.trim(),
    tabCount: tabs.result.tabs.length
  };
}

async function dockerBridgeGateway() {
  const result = await docker(['network', 'inspect', 'bridge', '--format={{(index .IPAM.Config 0).Gateway}}']);
  return result.stdout.trim() || '172.17.0.1';
}

function startFixture() {
  const seenCookies = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.local');
    if (url.pathname === '/set-cookie') {
      const marker = url.searchParams.get('marker') || 'marker';
      res.setHeader('set-cookie', `war_marker=${marker}; Path=/; Max-Age=3600; SameSite=Lax`);
      res.end(`<!doctype html><title>set-cookie</title>${marker}`);
      return;
    }
    if (url.pathname === '/echo-cookie') {
      seenCookies.push(req.headers.cookie || '');
      res.end(`<!doctype html><title>echo-cookie</title>${req.headers.cookie || ''}`);
      return;
    }
    if (url.pathname === '/phase2') {
      res.end(`<!doctype html><title>phase2</title>
        <button id="button" onclick="document.body.dataset.clicked='1'">Click</button>
        <input id="input" placeholder="Name">
        <textarea id="textarea"></textarea>
        <input id="check" type="checkbox">
        <select id="select"><option value="a">A</option><option value="b">B</option></select>
        <input id="file" type="file">
        <button id="show-delayed" onclick="setTimeout(()=>delayed.hidden=false,100)">Delayed</button>
        <button id="alert-button" onclick="setTimeout(()=>alert('ok'),100)">Alert</button>
        <div id="scroll" style="height:80px; overflow:auto"><div style="height:600px">scroll area</div></div>
        <div id="editable" contenteditable="true">edit</div>
        <div id="delayed" hidden>ready</div>`);
      return;
    }
    res.end(`<!doctype html><title>${url.pathname}</title><h1>${url.pathname}</h1>`);
  });
  return new Promise((resolve) => {
    server.listen(0, '0.0.0.0', () => {
      resolve({
        port: server.address().port,
        seenCookies,
        close: () => server.close()
      });
    });
  });
}

function docker(args) {
  return execFileP('docker', args, { timeout: 120000 });
}

function execFileP(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function isContainerRunning(container) {
  const result = await docker(['inspect', '-f', '{{.State.Running}}', container]).catch(() => ({ stdout: 'false' }));
  return result.stdout.trim() === 'true';
}

function writeArtifact(name, artifact) {
  const file = path.join(ARTIFACT_DIR, `${name}-${Date.now()}.json`);
  fs.writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`artifact=${file}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function average(values) {
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function target(targetId, selector) {
  return { targetId, target: { selectorType: 'css', value: selector } };
}

function summarizeCommandLatencies(commands) {
  const grouped = {};
  for (const command of commands) {
    for (const key of new Set([command.type, command.metric].filter(Boolean))) {
      grouped[key] ||= [];
      grouped[key].push(command.ms);
    }
  }
  return Object.fromEntries(Object.entries(grouped).map(([type, values]) => [type, {
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: Math.max(...values),
    count: values.length
  }]));
}

function assertPhase2PerformanceGate(artifact) {
  const perf = artifact.performance || {};
  assert.equal(artifact.cleanup?.containerRunning, false, 'performance container was left running');
  assert((perf['input.click:x11']?.p95 ?? Infinity) <= 80, `X11 click p95 too high: ${perf['input.click:x11']?.p95}`);
  assert((perf['input.keyDown:x11']?.p95 ?? Infinity) <= 80, `X11 keyDown p95 too high: ${perf['input.keyDown:x11']?.p95}`);
  assert((perf['input.keyUp:x11']?.p95 ?? Infinity) <= 80, `X11 keyUp p95 too high: ${perf['input.keyUp:x11']?.p95}`);
  assert((perf['input.click:cdp']?.p95 ?? Infinity) <= 50, `CDP click p95 too high: ${perf['input.click:cdp']?.p95}`);
  assert((perf['page.click']?.p95 ?? Infinity) <= 100, `semantic click p95 too high: ${perf['page.click']?.p95}`);
  assert((perf['input.stopAll']?.p95 ?? Infinity) <= 250, `stopAll p95 too high: ${perf['input.stopAll']?.p95}`);
  assert((artifact.stopAllLatencyMs ?? Infinity) <= 250, `outer stopAll latency too high: ${artifact.stopAllLatencyMs}`);
  assert(artifact.commands.every((command) => command.status === 'succeeded'), 'one or more commands failed');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert.equal = function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `Expected ${actual} to equal ${expected}`);
};

assert.notEqual = function notEqual(actual, expected, message) {
  if (actual === expected) throw new Error(message || `Expected ${actual} to differ from ${expected}`);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2] || 'smoke';
  const result = mode === 'soak'
    ? await runTabSoak()
    : mode === 'phase2-smoke'
      ? await runPhase2ContainerSmoke()
      : mode === 'performance'
        ? await runPhase2Performance()
        : mode === 'performance-gate'
          ? await runPhase2Performance({ gate: true })
        : await runContainerSmoke();
  console.log(JSON.stringify(result, null, 2));
}
