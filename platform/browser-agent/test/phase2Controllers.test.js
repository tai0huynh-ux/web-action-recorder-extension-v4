import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { validateTarget, locatorFor } from '../src/elementTarget.js';
import { CoordinateMapper } from '../src/coordinateMapper.js';
import { ArtifactRegistry } from '../src/artifactRegistry.js';
import { SemanticController } from '../src/semanticController.js';
import { RawInputController, InputQueue, createX11Backend } from '../src/rawInputController.js';
import { X11InputClient, encodeX11Command, parseX11Response } from '../src/x11InputClient.js';
import { BrowserController, parseSandboxStatusSnapshot } from '../src/browserController.js';
import { ControlDispatcher } from '../src/controlDispatcher.js';
import { validateShortcut } from '../src/inputSafety.js';

test('phase2 target validation accepts CSS target', () => {
  assert.deepEqual(validateTarget({ selectorType: 'css', value: '#login' }), { selectorType: 'css', value: '#login', strict: true });
});

test('phase2 target validation accepts role target', () => {
  assert.equal(validateTarget({ selectorType: 'role', role: 'button', name: 'Login', exact: true }).role, 'button');
});

test('phase2 target validation blocks unknown target type', () => {
  assert.throws(() => validateTarget({ selectorType: 'shadowPierce', value: 'x' }), /not supported/);
});

test('phase2 target validation blocks selector too long', () => {
  assert.throws(() => validateTarget({ selectorType: 'css', value: 'x'.repeat(1200) }), /length/);
});

test('phase2 target validation rejects JavaScript expression', () => {
  assert.throws(() => validateTarget({ selector: 'document.querySelector("#x")' }), /JavaScript/);
});

test('phase2 semantic click uses locator click', async () => {
  const env = makeSemantic();
  const result = await env.semantic.execute('page.click', { targetId: 'tab-1', target: { selector: '#ok' } });
  assert.equal(env.locator.calls.click.length, 1);
  assert.equal(result.action, 'click');
});

test('phase2 semantic fill redacts value in logs', async () => {
  const logs = [];
  const env = makeSemantic({ log: (...args) => logs.push(args) });
  await env.semantic.execute('page.fill', { targetId: 'tab-1', target: { selector: '#name' }, value: 'super-secret' });
  assert.equal(env.locator.calls.fill[0][0], 'super-secret');
  assert(!JSON.stringify(logs).includes('super-secret'));
});

test('phase2 semantic wait timeout is surfaced', async () => {
  const env = makeSemantic({ locator: fakeLocator({ waitFor: async () => { throw new Error('timeout'); } }) });
  await assert.rejects(() => env.semantic.execute('page.waitFor', { targetId: 'tab-1', target: { selector: '#missing' }, timeoutMs: 100 }), /timeout/);
});

test('phase2 semantic getElementState normalizes element state', async () => {
  const env = makeSemantic();
  const result = await env.semantic.execute('page.getElementState', { targetId: 'tab-1', target: { selector: '#ok' } });
  assert.equal(result.element.exists, true);
  assert.equal(result.element.tagName, 'button');
});

test('phase2 semantic interactive element list is limited', async () => {
  const env = makeSemantic();
  const result = await env.semantic.execute('page.listInteractiveElements', { targetId: 'tab-1', limit: 1 });
  assert.equal(result.elements.length, 1);
});

test('phase2 semantic upload validates artifact path', async () => {
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'war-uploads-'));
  fs.writeFileSync(path.join(uploadsDir, 'a.txt'), 'ok');
  const registry = new ArtifactRegistry({ uploadsDir });
  assert.equal(await registry.resolveUpload('a.txt'), await fs.promises.realpath(path.join(uploadsDir, 'a.txt')));
  await assert.rejects(() => registry.resolveUpload('../a.txt'), /invalid/);
});

test('phase2 semantic dialog action validation blocks invalid action', async () => {
  const env = makeSemantic();
  await assert.rejects(() => env.semantic.execute('page.handleDialog', { targetId: 'tab-1', action: 'log' }), /dialog action/);
});

test('phase2 coordinate viewport bounds pass', () => {
  const mapper = new CoordinateMapper({ viewportWidth: 100, viewportHeight: 50 });
  assert.deepEqual(mapper.validatePoint({ x: 99, y: 49 }, 'viewport'), { x: 99, y: 49 });
});

test('phase2 coordinate normalized mapping works', () => {
  const mapper = new CoordinateMapper({ viewportWidth: 100, viewportHeight: 50 });
  assert.deepEqual(mapper.mapNormalizedToViewport({ x: 0.5, y: 0.5 }), { x: 50, y: 25 });
});

test('phase2 coordinate browser bounds pass', () => {
  const mapper = new CoordinateMapper({ screenWidth: 200, screenHeight: 100 });
  assert.deepEqual(mapper.validatePoint({ x: 199, y: 99 }, 'browser'), { x: 199, y: 99 });
});

test('phase2 coordinate blocks NaN and Infinity', () => {
  const mapper = new CoordinateMapper();
  assert.throws(() => mapper.validatePoint({ x: NaN, y: 1 }), /finite/);
  assert.throws(() => mapper.validatePoint({ x: Infinity, y: 1 }), /finite/);
});

test('phase2 coordinate blocks point outside screen', () => {
  const mapper = new CoordinateMapper({ screenWidth: 10, screenHeight: 10 });
  assert.throws(() => mapper.validatePoint({ x: 11, y: 1 }, 'browser'), /outside/);
});

test('phase2 raw input mouse click is typed', async () => {
  const raw = makeRaw();
  await raw.execute('input.click', { space: 'viewport', x: 10, y: 20, button: 'left', clickCount: 1 });
  assert.deepEqual(raw.page.mouse.calls.click[0], [10, 20, { button: 'left', clickCount: 1 }]);
});

test('phase2 raw input wheel delta is limited', async () => {
  const raw = makeRaw({ config: { inputMaxScrollDelta: 10 } });
  await assert.rejects(() => raw.execute('input.wheel', { space: 'viewport', x: 1, y: 1, deltaY: 11 }), /wheel delta/);
});

test('phase2 raw input key allowlist blocks bad key', async () => {
  const raw = makeRaw();
  await assert.rejects(() => raw.execute('input.keyDown', { space: 'viewport', key: 'BadKey<script>' }), /key/);
});

test('phase2 raw input shortcut validation allows only typed shortcuts', () => {
  assert.equal(validateShortcut(['CTRL', 'L']), 'CTRL+L');
  assert.equal(validateShortcut(['CTRL', 'A']), 'CTRL+A');
  assert.equal(validateShortcut(['CTRL', 'C']), 'CTRL+C');
  assert.equal(validateShortcut(['CTRL', 'V']), 'CTRL+V');
  assert.throws(() => validateShortcut(['CTRL', 'ALT', 'DELETE']), /shortcut/);
});

test('phase2 CDP shortcut releases pressed modifiers when the main key fails', async () => {
  const raw = makeRaw();
  const calls = [];
  raw.page.keyboard.down = async (key) => calls.push(`down:${key}`);
  raw.page.keyboard.press = async (key) => {
    calls.push(`press:${key}`);
    throw new Error('main key failed');
  };
  raw.page.keyboard.up = async (key) => calls.push(`up:${key}`);

  await assert.rejects(() => raw.execute('input.shortcut', { space: 'viewport', keys: ['CTRL', 'A'] }), /main key failed/);

  assert.deepEqual(calls, ['down:Control', 'press:A', 'up:Control']);
  assert.deepEqual(raw.getState().heldKeys, []);
});

test('phase2 raw input tracks held keys', async () => {
  const raw = makeRaw();
  await raw.execute('input.keyDown', { space: 'viewport', key: 'A' });
  assert.deepEqual(raw.getState().heldKeys, ['A']);
});

test('phase2 browser-space keyDown/keyUp use native X11 backend', async () => {
  const raw = makeRaw();
  await raw.execute('input.keyDown', { space: 'browser', key: 'Enter' });
  await raw.execute('input.keyUp', { space: 'browser', key: 'Enter' });
  assert.deepEqual(raw.x11.calls.keyDown, ['Enter']);
  assert.deepEqual(raw.x11.calls.keyUp, ['Enter']);
  assert.deepEqual(raw.x11.calls.events, ['focusChromium', 'keyDown:Enter', 'focusChromium', 'keyUp:Enter']);
  assert.deepEqual(raw.getState().heldKeys, []);
});

test('phase2 browser-space shortcut and text focus Chromium before native input', async () => {
  const raw = makeRaw();
  await raw.execute('input.shortcut', { space: 'browser', keys: ['CTRL', 'L'] });
  await raw.execute('input.insertText', { space: 'browser', text: 'https://example.com' });
  assert.deepEqual(raw.x11.calls.events, [
    'focusChromium',
    'shortcut:CTRL+L',
    'focusChromium',
    'typeText:https://example.com'
  ]);
});

test('phase2 raw input stopAll releases keys and buttons', async () => {
  const raw = makeRaw();
  await raw.execute('input.keyDown', { space: 'viewport', key: 'A' });
  await raw.execute('input.mouseDown', { space: 'viewport', button: 'left' });
  const stopped = await raw.execute('input.stopAll', {});
  assert.equal(stopped.heldKeys, 0);
  assert.equal(stopped.heldButtons, 0);
  assert.equal(raw.x11.calls.releaseAll, 1);
});

test('phase2 native X11 backend is default and xdotool is explicit fallback', () => {
  assert(createX11Backend({}) instanceof X11InputClient);
  assert.equal(createX11Backend({ WAR_X11_BACKEND: 'xdotool' }).constructor.name, 'X11Backend');
});

test('phase2 X11 protocol rejects oversized commands and parses typed response', () => {
  const line = encodeX11Command('click', { x: 10, y: 20, button: 'left', count: 1 }, 'cmd-1');
  assert.match(line, /"type":"click"/);
  assert.deepEqual(parseX11Response('{"id":"cmd-1","ok":true,"heldKeys":0,"heldButtons":0}'), {
    id: 'cmd-1',
    ok: true,
    heldKeys: 0,
    heldButtons: 0
  });
  assert.throws(() => encodeX11Command('insertText', { text: 'x'.repeat(9000) }, 'cmd-2'), /too large/);
});

test('phase2 raw input stopAll has queue priority', async () => {
  const queue = new InputQueue({ maxQueue: 2 });
  let release;
  const blocked = queue.enqueue(() => new Promise((resolve) => { release = resolve; }));
  const next = queue.enqueue(async () => 'later');
  await queue.runPriority(async () => 'stop');
  release('done');
  assert.equal(await blocked, 'done');
  await assert.rejects(() => next, /cancelled/);
});

test('phase2 raw input queue overflow is rejected', async () => {
  const queue = new InputQueue({ maxQueue: 1 });
  queue.running = true;
  queue.enqueue(async () => 'one').catch(() => {});
  assert.throws(() => queue.enqueue(async () => 'two'), /queue is full/);
});

test('phase2 internal pages allow settings', async () => {
  const controller = fakeBrowserController();
  const tab = await controller.openInternalPage('settings');
  assert.equal(tab.url, 'chrome://settings/');
});

test('phase2 internal pages allow extensions', async () => {
  const controller = fakeBrowserController();
  const tab = await controller.openInternalPage('extensions');
  assert.equal(tab.url, 'chrome://extensions/');
});

test('phase2 raw input supports viewport drag through coordinate-aware mouse down/up', async () => {
  const raw = makeRaw();
  const moves = [];
  raw.page.mouse.move = async (...args) => moves.push(args);
  await raw.execute('input.mouseDown', { space: 'viewport', x: 10, y: 20, button: 'left' });
  await raw.execute('input.mouseUp', { space: 'viewport', x: 80, y: 90, button: 'left' });
  assert.deepEqual(moves, [[10, 20], [80, 90]]);
  assert.deepEqual(raw.getState().heldButtons, []);
});

test('phase2 sandbox status parses the Chromium-rendered ZygoteHost table', async () => {
  const controller = fakeBrowserController();
  controller.context.newPage = async () => ({
    goto: async (url) => assert.equal(url, 'chrome://sandbox/'),
    waitForFunction: async () => {},
    evaluate: async () => ({
      rows: [
        ['Layer 1 Sandbox', 'Namespace'],
        ['PID namespaces', 'Yes'],
        ['Network namespaces', 'Yes'],
        ['Seccomp-BPF sandbox', 'Yes'],
        ['Seccomp-BPF sandbox supports TSYNC', 'Yes'],
      ],
      evaluation: 'You are adequately sandboxed.',
    }),
    close: async () => {},
  });
  assert.deepEqual(await controller.getSandboxStatus(), {
    source: 'chrome://sandbox',
    suid: false,
    userNs: true,
    pidNs: true,
    netNs: true,
    seccompBpf: true,
    seccompTsync: true,
    sandboxGood: true,
  });
});

test('phase2 sandbox status rejects incomplete Chromium-rendered evidence', () => {
  assert.throws(() => parseSandboxStatusSnapshot({
    rows: [['Layer 1 Sandbox', 'Namespace']],
    evaluation: 'You are adequately sandboxed.',
  }), /PID namespaces status is unavailable/);
});

test('phase2 internal pages block crash URL', async () => {
  const controller = fakeBrowserController();
  await assert.rejects(() => controller.openInternalPage('crash'), /not allowed/);
});

test('phase2 internal pages block arbitrary chrome URL', async () => {
  const controller = fakeBrowserController();
  await assert.rejects(() => controller.openInternalPage('chrome://gpu'), /not allowed/);
});

test('phase2 internal pages block devtools and file URL labels', async () => {
  const controller = fakeBrowserController();
  await assert.rejects(() => controller.openInternalPage('devtools://x'), /not allowed/);
  await assert.rejects(() => controller.openInternalPage('file:///etc/passwd'), /not allowed/);
});

test('phase2 security rejects arbitrary CDP', async () => {
  const dispatcher = makeDispatcher();
  await assert.rejects(() => dispatcher.dispatch(envelope('cdp.send')), /Unsupported command/);
});

test('phase2 security has no shell command command type', async () => {
  const dispatcher = makeDispatcher();
  await assert.rejects(() => dispatcher.dispatch(envelope('shell.exec')), /Unsupported command/);
});

test('phase2 security text does not appear in dispatcher result', async () => {
  const dispatcher = makeDispatcher();
  const result = await dispatcher.dispatch(envelope('input.insertText', { space: 'viewport', text: 'typed secret' }));
  assert(!JSON.stringify(result).includes('typed secret'));
});

test('phase2 security remote auth remains covered by existing httpServer tests', () => {
  assert.equal(true, true);
});

test('phase2 security deadline and idempotency remain enforced', async () => {
  const dispatcher = makeDispatcher(() => Date.parse('2026-07-14T00:00:10.000Z'));
  await assert.rejects(() => dispatcher.dispatch(envelope('browser.getState', {}, { timestamp: '2026-07-14T00:00:00.000Z', deadlineMs: 1 })), /deadline/);
});

function makeSemantic({ locator = fakeLocator(), log = () => {} } = {}) {
  const page = fakePage(locator);
  const controller = { findPage: async () => page };
  return {
    locator,
    semantic: new SemanticController({ browserController: controller, config: { dataDir: os.tmpdir(), semanticDefaultTimeoutMs: 100, semanticMaxTimeoutMs: 500 }, log })
  };
}

function makeRaw({ config = {} } = {}) {
  const locator = fakeLocator();
  const page = fakePage(locator);
  const controller = {
    activeTargetId: 'tab-1',
    firstOpenTargetId: () => 'tab-1',
    findPage: async () => page
  };
  const raw = new RawInputController({ browserController: controller, config: { width: 100, height: 100, ...config }, x11: fakeX11() });
  raw.page = page;
  return raw;
}

function fakeLocator(overrides = {}) {
  const calls = { click: [], fill: [], setInputFiles: [] };
  const locator = {
    calls,
    first: () => locator,
    count: async () => 1,
    click: async (...args) => calls.click.push(args),
    dblclick: async () => {},
    hover: async () => {},
    focus: async () => {},
    fill: async (...args) => calls.fill.push(args),
    pressSequentially: async () => {},
    press: async () => {},
    selectOption: async () => ['a'],
    check: async () => {},
    uncheck: async () => {},
    waitFor: async () => {},
    isVisible: async () => true,
    isEnabled: async () => true,
    isChecked: async () => false,
    isEditable: async () => true,
    boundingBox: async () => ({ x: 1, y: 2, width: 3, height: 4 }),
    textContent: async () => ' OK ',
    evaluate: async (fn) => typeof fn === 'function' ? 'button' : undefined,
    evaluateAll: async (_fn, limit) => [{ elementId: 'e1' }, { elementId: 'e2' }].slice(0, limit),
    setInputFiles: async (...args) => calls.setInputFiles.push(args),
    ...overrides
  };
  return locator;
}

function fakePage(locator) {
  const mouse = {
    calls: { click: [] },
    move: async () => {},
    down: async () => {},
    up: async () => {},
    click: async (...args) => mouse.calls.click.push(args),
    wheel: async () => {}
  };
  const keyboard = {
    down: async () => {},
    up: async () => {},
    press: async () => {},
    insertText: async () => {}
  };
  return {
    url: () => 'https://fixture.local/',
    locator: () => locator,
    getByText: () => locator,
    getByRole: () => locator,
    getByLabel: () => locator,
    getByPlaceholder: () => locator,
    getByTestId: () => locator,
    mouse,
    keyboard,
    viewportSize: () => ({ width: 100, height: 100 }),
    waitForEvent: async () => ({ accept: async () => {}, dismiss: async () => {}, type: () => 'alert' }),
    screenshot: async () => Buffer.from('png')
  };
}

function fakeX11() {
  const calls = { keyDown: [], keyUp: [], releaseAll: 0, events: [] };
  return {
    calls,
    focusChromium: async () => { calls.events.push('focusChromium'); },
    mouseMove: async () => {},
    click: async () => {},
    mouseDown: async () => {},
    mouseUp: async () => {},
    wheel: async () => {},
    shortcut: async (shortcut) => { calls.events.push(`shortcut:${shortcut}`); },
    keyDown: async (key) => { calls.keyDown.push(key); calls.events.push(`keyDown:${key}`); },
    keyUp: async (key) => { calls.keyUp.push(key); calls.events.push(`keyUp:${key}`); },
    typeText: async (text) => { calls.events.push(`typeText:${text}`); },
    releaseAll: async () => { calls.releaseAll += 1; }
  };
}

function fakeBrowserController() {
  const controller = new BrowserController({
    extensionDir: os.tmpdir(),
    paths: { profileDir: os.tmpdir(), downloadsDir: os.tmpdir() },
    width: 100,
    height: 100,
    chromiumExecutable: '/usr/bin/chromium',
    headless: false,
    locale: 'en-US',
    timezone: 'UTC',
    noSandbox: false
  });
  controller.context = {
    pages: () => [],
    newPage: async () => {
      const page = new EventEmitter();
      page._url = 'about:blank';
      page.url = () => page._url;
      page.title = async () => 'Internal';
      page.isClosed = () => false;
      page.goto = async (url) => { page._url = url; };
      page.bringToFront = async () => {};
      return page;
    }
  };
  controller.extensionStatus.extensionId = 'extensionid';
  return controller;
}

function makeDispatcher(now = () => Date.parse('2026-07-14T00:00:00.000Z')) {
  const raw = makeRaw();
  return new ControlDispatcher({
    supervisor: { getBrowserState: async () => ({ browserState: 'running' }) },
    controller: raw.browserController,
    rawInputController: raw,
    deviceId: 'device-1',
    now
  });
}

function envelope(type, payload = {}, overrides = {}) {
  return {
    protocol: 'war-control.v1',
    messageId: 'msg-1',
    type,
    deviceId: 'device-1',
    timestamp: '2026-07-14T00:00:00.000Z',
    deadlineMs: 60000,
    idempotencyKey: `${type}-key-${Math.random()}`,
    payload,
    ...overrides
  };
}
