import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXTENSION_NAME = 'Web Action Recorder Runner MVP';
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXTENSION_PATH = REPO_ROOT;
export const ARTIFACT_ROOT = path.join(tmpdir(), 'war-browser-mv3-artifacts');

export function createTrace(kind) {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const artifactDir = path.join(ARTIFACT_ROOT, `${runId}-${kind}`);
  mkdirSync(artifactDir, { recursive: true });
  const screenshotPath = path.join(artifactDir, 'screenshot.png');
  const tracePath = path.join(artifactDir, 'trace.json');
  return {
    status: 'Blocked',
    browserName: '',
    browserVersion: '',
    browserExecutablePath: '',
    extensionPath: EXTENSION_PATH,
    extensionTargetDetected: false,
    extensionId: '',
    screenshotPath,
    tracePath,
    steps: [],
    reason: ''
  };
}

export function step(trace, name, detail = '') {
  trace.steps.push({ time: new Date().toISOString(), name, detail });
}

export function finish(trace, status, reason, exitCode) {
  trace.status = status;
  trace.reason = reason;
  writeFileSync(trace.tracePath, JSON.stringify(trace, null, 2));
  const lines = [
    `Browser MV3 regression status: ${status}`,
    `Browser: ${trace.browserName || 'unknown'} ${trace.browserVersion || ''}`.trim(),
    `Browser executable: ${trace.browserExecutablePath || 'unknown'}`,
    `Extension path: ${trace.extensionPath}`,
    `Extension target/service worker detected: ${trace.extensionTargetDetected ? 'yes' : 'no'}`,
    `Reason: ${reason}`,
    `Screenshot: ${existsSync(trace.screenshotPath) ? trace.screenshotPath : 'not captured'}`,
    `Trace: ${trace.tracePath}`
  ];
  console.log(lines.join('\n'));
  process.exitCode = exitCode;
  return { status, reason };
}

export function parseBrowserArgs(argv = process.argv.slice(2), env = process.env) {
  const args = new Map(argv.map((arg) => {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    return match ? [match[1], match[2]] : [arg.replace(/^--/, ''), true];
  }));
  return {
    requested: String(args.get('browser') || env.WAR_BROWSER || '').toLowerCase(),
    overridePath: env.WAR_BROWSER_PATH || ''
  };
}

export function browserCandidates() {
  return [
    { name: 'Chrome', key: 'chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    { name: 'Chrome', key: 'chrome', path: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' },
    { name: 'Edge', key: 'edge', path: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
    { name: 'Edge', key: 'edge', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
    { name: 'Chromium', key: 'chromium', path: 'C:\\Program Files\\Chromium\\Application\\chrome.exe' }
  ];
}

export function selectBrowser(options = {}, exists = existsSync) {
  const { requested, overridePath } = { ...parseBrowserArgs(), ...options };
  if (overridePath) {
    if (!exists(overridePath)) throw new Error(`WAR_BROWSER_PATH does not exist: ${overridePath}`);
    return { name: requested || 'Custom Chromium', key: requested || 'custom', path: overridePath };
  }
  const found = browserCandidates().find((item) => exists(item.path) && (!requested || requested === item.key));
  if (!found) throw new Error(`No compatible browser executable found${requested ? ` for ${requested}` : ''}. Set WAR_BROWSER_PATH to override.`);
  return found;
}

export function buildLaunchArgs({ userDataDir, port, extensionPath = EXTENSION_PATH, startUrl = 'about:blank' }) {
  return [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
    startUrl
  ];
}

export async function launchBrowser(browserPath, extensionPath = EXTENSION_PATH) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'war-browser-profile-'));
  const port = await findFreePort();
  const child = spawn(browserPath, buildLaunchArgs({ userDataDir, port, extensionPath }), { stdio: 'ignore' });
  child.unref();
  const version = await waitFor(async () => {
    const data = await getJson(port, '/json/version');
    return data.Browser;
  }, 15000, 'browser remote debugging endpoint');
  return {
    port,
    version,
    userDataDir,
    close() {
      if (!child.killed) child.kill();
    }
  };
}

export async function detectExtensionOrBlock({ trace, browser, run }) {
  const extensionTarget = await findExtensionTarget(run.port, EXTENSION_NAME);
  if (extensionTarget) {
    trace.extensionTargetDetected = true;
    trace.extensionId = extensionTarget.url.split('/')[2];
    step(trace, 'Detected extension target', `${extensionTarget.type}: ${extensionTarget.url}`);
    return { ok: true, extensionTarget };
  }
  await captureExtensionsScreenshot(run.port, trace).catch((error) => step(trace, 'Screenshot capture failed', error.message));
  const control = await probeMinimalExtension(browser.path);
  const reason = [
    `No MV3 target for "${EXTENSION_NAME}" was detected after launch.`,
    `Minimal control extension loaded: ${control.loaded ? 'yes' : 'no'}.`,
    control.reason ? `Control probe: ${control.reason}` : '',
    'The installed browser appears to refuse or ignore --load-extension in this environment.'
  ].filter(Boolean).join(' ');
  return { ok: false, reason };
}

export async function findExtensionTarget(port, expectedName) {
  return waitFor(async () => {
    const targets = await getJson(port, '/json/list');
    for (const target of targets) {
      if (!['service_worker', 'background_page'].includes(target.type)) continue;
      if (!target.url.startsWith('chrome-extension://')) continue;
      const client = new CdpClient(target.webSocketDebuggerUrl);
      try {
        const result = await client.evaluate('chrome.runtime.getManifest().name');
        if (result === expectedName) return target;
      } catch {
        // Ignore unrelated built-in extension targets.
      } finally {
        client.close();
      }
    }
    return null;
  }, 8000, 'extension service worker target').catch(() => null);
}

export async function probeMinimalExtension(browserPath) {
  const dir = mkdtempSync(path.join(tmpdir(), 'war-minimal-extension-'));
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'WAR Minimal MV3 Probe',
    version: '1.0.0',
    background: { service_worker: 'sw.js' }
  }), 'utf8');
  writeFileSync(path.join(dir, 'sw.js'), 'globalThis.__warProbe = true;\n', 'utf8');
  const run = await launchBrowser(browserPath, dir);
  try {
    const target = await findExtensionTarget(run.port, 'WAR Minimal MV3 Probe');
    return target ? { loaded: true } : { loaded: false, reason: 'Minimal MV3 service worker target was not detected.' };
  } catch (error) {
    return { loaded: false, reason: error.message };
  } finally {
    run.close();
    safeRemove(run.userDataDir);
    safeRemove(dir);
  }
}

export async function openTarget(port, url) {
  const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then((response) => response.json());
  return new CdpClient(target.webSocketDebuggerUrl);
}

export async function openExtensionEditor(port, extensionId) {
  const page = await openTarget(port, `chrome-extension://${extensionId}/ui/sidepanel.html?standalone=1`);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await waitForPageReady(page);
  await waitForExpression(page, 'Boolean(document.querySelector("#newProfileBtn") && document.querySelector("#canvas-container"))');
  await waitForExpression(page, 'document.querySelector("#profileSelect").options.length > 0');
  return page;
}

export async function waitForPageReady(page) {
  await waitForExpression(page, 'document.readyState === "complete" || document.readyState === "interactive"', 10000);
}

export async function waitForExpression(page, expression, timeout = 10000) {
  return waitFor(async () => evaluate(page, expression), timeout, expression);
}

export async function evaluate(page, expression) {
  const result = await page.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime evaluation failed');
  return result.result.value;
}

export async function click(page, selector) {
  await evaluate(page, `document.querySelector(${JSON.stringify(selector)}).click()`);
}

export async function mouseClick(page, x, y) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left' });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

export async function mouseMove(page, x, y) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
}

export async function keyPress(page, key) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
}

export async function setViewport(page, width, height) {
  await page.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  });
}

export async function captureExtensionsScreenshot(port, trace) {
  const page = await openTarget(port, 'chrome://extensions/');
  await page.send('Page.enable');
  await waitForPageReady(page);
  await captureScreenshot(page, trace);
}

export async function captureScreenshot(page, trace) {
  await page.send('Page.bringToFront').catch(() => {});
  await setViewport(page, 1280, 900).catch(() => {});
  const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(trace.screenshotPath, Buffer.from(shot.data, 'base64'));
  step(trace, 'Captured screenshot', trace.screenshotPath);
}

export function near(actual, expected, tolerance = 1) {
  return Boolean(actual) && Math.abs(Number(actual.x) - expected.x) <= tolerance && Math.abs(Number(actual.y) - expected.y) <= tolerance;
}

export async function getJson(port, endpoint) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${endpoint}`);
  return response.json();
}

export async function findFreePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

export async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

export async function finishFailureWithScreenshot({ trace, page, error }) {
  if (page) {
    await Promise.race([
      captureScreenshot(page, trace).catch((captureError) => step(trace, 'Failure screenshot capture failed', captureError.message)),
      new Promise((resolve) => setTimeout(() => {
        step(trace, 'Failure screenshot capture failed', 'Timed out after 6000 ms');
        resolve();
      }, 6000))
    ]);
  }
  return finish(trace, 'Fail', error?.stack || error?.message || String(error), 1);
}

export function safeRemove(target) {
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    // Temp cleanup best effort.
  }
}

export class CdpClient {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = reject;
    });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    };
    this.socket.onclose = () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP socket closed'));
      this.pending.clear();
    };
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP method ${method}`));
      }, 5000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime evaluation failed');
    return result.result.value;
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // Ignore close races.
    }
  }
}
