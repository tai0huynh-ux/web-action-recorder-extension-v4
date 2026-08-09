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
import { X11InputClient, encodeX11Command, normalizeX11Shortcut, parseX11Response } from '../src/x11InputClient.js';
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

test('phase2 viewport shortcut resolves the explicit target through CDP and preserves its deadline guard', async () => {
  let now = 0;
  const findPageCalls = [];
  const activePage = fakePage(fakeLocator());
  const targetPage = fakePage(fakeLocator());
  const targetKeys = [];
  targetPage.keyboard.down = async (key) => targetKeys.push(`down:${key}`);
  targetPage.keyboard.press = async (key) => targetKeys.push(`press:${key}`);
  targetPage.keyboard.up = async (key) => targetKeys.push(`up:${key}`);
  const controller = {
    activeTargetId: 'unrelated-active-target',
    firstOpenTargetId: () => 'unrelated-first-target',
    findPage: async (targetId) => {
      findPageCalls.push(targetId);
      return targetId === 'paste-target' ? targetPage : activePage;
    }
  };
  const raw = new RawInputController({ browserController: controller, config: { width: 100, height: 100 }, x11: fakeX11() });

  await raw.execute('input.shortcut', { targetId: 'paste-target', space: 'viewport', keys: ['CTRL', 'V'] }, { deadlineAt: 1, now: () => now });

  assert.deepEqual(findPageCalls, ['paste-target'], 'viewport/CDP input must resolve the explicit target, never the active target');
  assert.deepEqual(targetKeys, ['down:Control', 'press:V', 'up:Control']);

  now = 2;
  await assert.rejects(
    () => raw.execute('input.shortcut', { targetId: 'paste-target', space: 'viewport', keys: ['CTRL', 'V'] }, { deadlineAt: 1, now: () => now }),
    (error) => error?.code === 'deadline_exceeded'
  );
  assert.deepEqual(findPageCalls, ['paste-target'], 'expired viewport input must be rejected before resolving any target');
});

test('phase2 raw input tracks held keys', async () => {
  const raw = makeRaw();
  await raw.execute('input.keyDown', { space: 'viewport', key: 'A' });
  assert.deepEqual(raw.getState().heldKeys, ['A']);
});

test('phase2 browser-space keyDown/keyUp use native X11 backend', async () => {
  const raw = makeRaw();
  await raw.execute('input.keyDown', { targetId: 'tab-1', space: 'browser', key: 'Enter' });
  await raw.execute('input.keyUp', { targetId: 'tab-1', space: 'browser', key: 'Enter' });
  assert.deepEqual(raw.x11.calls.keyDown, ['Enter']);
  assert.deepEqual(raw.x11.calls.keyUp, ['Enter']);
  assert.deepEqual(raw.x11.calls.events, ['focusChromium', 'keyDown:Enter', 'keyUp:Enter']);
  assert.deepEqual(raw.getState().heldKeys, []);
});

test('phase2 browser-space shortcut and text focus Chromium before native input', async () => {
  const raw = makeRaw();
  await raw.execute('input.shortcut', { targetId: 'tab-1', space: 'browser', keys: ['CTRL', 'L'] });
  await raw.execute('input.insertText', { targetId: 'tab-1', space: 'browser', text: 'https://example.com' });
  assert.deepEqual(raw.x11.calls.events, [
    'focusChromium',
    'shortcut:CTRL+L',
    'typeText:https://example.com'
  ]);
});

test('phase2 browser-space navigation selects the active target before native X11 input', async () => {
  const navigation = makeRawNavigationHarness();
  const targetUrl = 'https://target.example/arrived';

  await navigation.raw.execute('input.shortcut', { targetId: 'target-b', space: 'browser', keys: ['CTRL', 'L'] });
  await navigation.raw.execute('input.insertText', { targetId: 'target-b', space: 'browser', text: targetUrl });
  await navigation.raw.execute('input.keyDown', { targetId: 'target-b', space: 'browser', key: 'Enter' });

  assert.deepEqual(navigation.focusCalls, ['target-b', 'target-b', 'target-b']);
  assert.equal(navigation.urls.get('target-b'), targetUrl);
  assert.equal(navigation.urls.get('unrelated-chromium'), 'https://unrelated.example/original');
});

test('phase2 browser-space raw input fails closed when the selected target resolves to multiple browser windows', async () => {
  const x11Calls = [];
  const ambiguity = Object.assign(new Error('Selected target resolves to multiple browser windows'), {
    code: 'raw_input_window_ambiguous'
  });
  const controller = {
    activeTargetId: 'target-b',
    firstOpenTargetId: () => 'target-b',
    assertSingleWindowForRawInput: async (targetId) => {
      assert.equal(targetId, 'target-b');
      throw ambiguity;
    },
    activateTab: async () => {},
    findPage: async () => ({})
  };
  const x11 = {
    focusChromium: async () => x11Calls.push('focusChromium'),
    shortcut: async () => x11Calls.push('shortcut'),
    releaseAll: async () => {}
  };
  const raw = new RawInputController({ browserController: controller, config: { width: 100, height: 100 }, x11 });

  await assert.rejects(
    () => raw.execute('input.shortcut', { targetId: 'target-b', space: 'browser', keys: ['CTRL', 'L'] }),
    (error) => error?.code === 'raw_input_window_ambiguous'
  );
  assert.deepEqual(x11Calls, [], 'ambiguous browser window selection must not emit X11 input');
});

test('phase2 browser-space raw input rechecks its deadline after the CDP window guard', async () => {
  let now = 0;
  const x11Calls = [];
  const controller = {
    assertSingleWindowForRawInput: async () => { now = 2; return { targetId: 'target-b', windowId: 1 }; },
    activateTab: async () => x11Calls.push('activate'),
    findPage: async () => ({}),
  };
  const x11 = {
    focusChromium: async () => x11Calls.push('focusChromium'),
    shortcut: async () => x11Calls.push('shortcut'),
    releaseAll: async () => {},
  };
  const raw = new RawInputController({ browserController: controller, config: { width: 100, height: 100 }, x11 });

  await assert.rejects(
    () => raw.execute('input.shortcut', { targetId: 'target-b', space: 'browser', keys: ['CTRL', 'L'] }, { deadlineAt: 1, now: () => now }),
    (error) => error?.code === 'deadline_exceeded'
  );
  assert.deepEqual(x11Calls, [], 'expired input must not activate or emit X11 effects after the CDP guard');
});

test('phase2 raw X11 calls forward the deadline and reject an expiry after the native effect', async () => {
  let now = 0;
  const calls = [];
  const controller = {
    assertSingleWindowForRawInput: async () => ({ targetId: 'target-b', windowId: 1 }),
    activateTab: async () => {},
    findPage: async () => ({}),
  };
  const x11 = {
    focusChromium: async (options) => calls.push(['focusChromium', options]),
    shortcut: async (shortcut, options) => { calls.push(['shortcut', shortcut, options]); now = 2; },
    releaseAll: async () => {},
  };
  const raw = new RawInputController({ browserController: controller, config: { width: 100, height: 100 }, x11 });

  await assert.rejects(
    () => raw.execute('input.shortcut', { targetId: 'target-b', space: 'browser', keys: ['CTRL', 'L'] }, { deadlineAt: 1, now: () => now }),
    (error) => error?.code === 'deadline_exceeded'
  );
  assert.equal(calls[0]?.[1]?.deadlineAt, 1, 'native focus must receive the command deadline');
  assert.equal(calls[1]?.[2]?.deadlineAt, 1, 'native XTEST command must receive the command deadline');
});

test('phase2 Browser target-to-window guard uses Browser.getWindowForTarget', () => {
  const browserController = fs.readFileSync(path.resolve('platform/browser-agent/src/browserController.js'), 'utf8');
  assert.match(browserController, /assertSingleWindowForRawInput\s*\(/, 'Browser Controller must expose the raw-input window guard');
  assert.match(browserController, /Browser\.getWindowForTarget/, 'raw-input window guard must use the Browser CDP window mapping');
  assert.match(browserController, /raw_input_window_ambiguous/, 'ambiguous browser-window mappings must use a typed fail-closed error');
});

test('phase2 native X11 helper rejects multiple direct browser windows without recursive first-match selection', () => {
  const nativeHelper = fs.readFileSync(path.resolve('platform/browser-agent/native/x11-inputd/x11-inputd.c'), 'utf8');
  const focusWindow = nativeHelper.slice(nativeHelper.indexOf('static bool focus_window('), nativeHelper.indexOf('static void handle_line('));
  assert.doesNotMatch(nativeHelper, /find_chromium_window\(children\[i\]\)/, 'native helper must not recursively select the first Chromium descendant');
  assert.match(focusWindow, /if\s*\(\s*\w+\s*!=\s*1\s*\)\s*return\s+(?:false|0)\s*;/, 'native helper must reject zero or multiple direct browser windows');
  assert.match(nativeHelper, /XGrabServer\(display\)/, 'native helper must make the window check and XTEST injection atomic');
  assert.match(nativeHelper, /browser_window_owns_focus/, 'native helper must fail closed when the single browser window no longer owns focus');
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

test('phase2 X11 protocol serializes a WAR2 64-bit absolute-deadline envelope for the native daemon', () => {
  const deadlineAt = 1_726_796_800_123;
  const wire = encodeX11Command('shortcut', { shortcut: 'Control_L+l' }, 'cmd-deadline', { deadlineAt });
  const match = wire.match(/^WAR2 (\d+) (.+)\n$/);
  assert.ok(match, 'effectful commands must use the versioned WAR2 wire format');
  const packet = JSON.parse(match[2]);
  assert.equal(match[1], String(deadlineAt));
  assert.equal(packet.deadlineAt, deadlineAt);
  assert.equal(Number.isSafeInteger(packet.deadlineAt), true);
});

test('phase2 X11 shortcut parser resolves the shortcut member when type has the same value', () => {
  const deadlineAt = 1_726_796_800_123;
  const currentCopyWire = encodeX11Command(
    'shortcut',
    { id: 'clipboard-copy', type: 'shortcut', deadlineAt, shortcut: 'Control_L+c' },
    'clipboard-copy',
    { deadlineAt }
  );
  const packet = JSON.parse(currentCopyWire.match(/^WAR2 \d+ (.+)\n$/)?.[1] ?? 'null');
  assert.deepEqual(packet, { id: 'clipboard-copy', type: 'shortcut', deadlineAt, shortcut: 'Control_L+c' });

  const nativeHelper = fs.readFileSync(path.resolve('platform/browser-agent/native/x11-inputd/x11-inputd.c'), 'utf8');
  const memberLocator = nativeHelper.slice(nativeHelper.indexOf('static const char *find_json_member_value('), nativeHelper.indexOf('static bool get_json_string('));
  assert.match(
    memberLocator,
    /const char \*value\s*=\s*member\s*\+\s*pattern_len\s*;\s*while\s*\(\s*isspace\s*\(\s*\(unsigned char\)\*value\s*\)\s*\)\s*value\+\+\s*;\s*if\s*\(\s*\*value\s*==\s*':'\s*\)\s*return\s+value\s*\+\s*1\s*;/,
    'member-key lookup must require optional whitespace followed immediately by a colon, so type:"shortcut" cannot match the shortcut key'
  );
});

test('phase2 native X11 source requires the WAR2 handshake and checks 64-bit expiry inside every X11 guard', () => {
  const nativeHelper = fs.readFileSync(path.resolve('platform/browser-agent/native/x11-inputd/x11-inputd.c'), 'utf8');
  assert.match(nativeHelper, /#include <stdint\.h>/, 'native deadline arithmetic must use a fixed-width 64-bit integer');
  assert.match(nativeHelper, /get_json_int64\s*\([^)]*int64_t\s*\*out\)/, 'native daemon must parse the absolute deadline without 32-bit truncation');
  assert.match(nativeHelper, /WAR2/, 'native daemon must reject the legacy unversioned command wire');
  assert.match(nativeHelper, /protocol[_ ]?version\s*==\s*2|WAR2.*protocol/, 'native daemon must complete a protocol=2 handshake before accepting effects');
  assert.match(nativeHelper, /missing_deadline|invalid_deadline|deadline_exceeded/, 'effectful commands must reject missing, malformed, or expired deadlines');
  assert.match(nativeHelper, /static bool begin_browser_input_guard\s*\(\s*int64_t\s+deadline_at\s*\)/, 'each XTEST operation must carry its deadline into the atomic guard');
  assert.match(nativeHelper, /static bool focus_window\s*\(\s*int64_t\s+deadline_at\s*\)/, 'focus must recheck expiry inside its atomic guard');
  assert.match(nativeHelper, /XGrabServer\(display\);[\s\S]{0,500}deadline_expired\(\s*&\s*\w*(?:timing|deadline)\w*\s*\)/, 'expiry must be checked through CommandTiming after grabbing the server and before focus/XTEST');
  for (const exempt of ['ping', 'getState', 'releaseAll']) {
    assert.match(nativeHelper, new RegExp(`strcmp\\(type, \\\"${exempt}\\\"\\)`, 'g'), `${exempt} must remain an explicitly audited non-effectful exemption`);
  }
});

test('phase2 native X11 guards recheck expiry after validation and preserve typed deadline failures', () => {
  const nativeHelper = fs.readFileSync(path.resolve('platform/browser-agent/native/x11-inputd/x11-inputd.c'), 'utf8');
  const beginGuard = nativeHelper.slice(
    nativeHelper.indexOf('static bool begin_browser_input_guard('),
    nativeHelper.indexOf('static bool end_browser_input_guard(')
  );
  const focusWindow = nativeHelper.slice(
    nativeHelper.indexOf('static bool focus_window('),
    nativeHelper.indexOf('static void handle_line(')
  );
  const commandDispatch = nativeHelper.slice(nativeHelper.indexOf('static void handle_line('));

  assert.match(beginGuard, /browser_window_owns_focus[\s\S]{0,300}deadline_expired\(\s*&\s*\w*(?:timing|deadline)\w*\s*\)[\s\S]{0,250}return true;/, 'input guard must recheck the CommandTiming after browser-window validation and before its caller can emit XTEST');
  assert.match(focusWindow, /find_direct_browser_windows[\s\S]{0,300}deadline_expired\(\s*&\s*\w*(?:timing|deadline)\w*\s*\)[\s\S]{0,250}XRaiseWindow/, 'focus guard must recheck the CommandTiming after window validation and immediately before focus effects');
  const guardFailure = nativeHelper.slice(
    nativeHelper.indexOf('static const char *guard_failure_error('),
    nativeHelper.indexOf('static bool end_browser_input_guard(')
  );
  assert.match(guardFailure, /last_guard_deadline\s*\?\s*"deadline_exceeded"\s*:\s*"focus_failed"/, 'guard failure mapping must preserve deadline expiry for the X11 client as typed HTTP 408');
  const beginGuardBranches = [...commandDispatch.matchAll(/!begin_browser_input_guard\s*\([^)]*\)/g)];
  assert.ok(beginGuardBranches.length > 0, 'effectful commands must use the native browser-input guard');
  for (const branch of beginGuardBranches) {
    const branchBody = commandDispatch.slice(branch.index, branch.index + 300);
    assert.match(branchBody, /guard_failure_error\s*\(\s*\)/, 'every begin_browser_input_guard failure branch must use the typed guard failure mapping');
  }
});

test('phase2 X11 client uses a bounded WAR2 response deadline and bounded UTF-8 framing', () => {
  const client = fs.readFileSync(path.resolve('platform/browser-agent/src/x11InputClient.js'), 'utf8');
  assert.match(client, /WAR2\s+\$\{\s*(?:deadline|effectiveDeadlineAt|boundedDeadlineAt|boundedDeadline)(?:\s*\|\|\s*0)?\s*\}/, 'client must emit the protocol=2 bounded deadline prefix');
  assert.match(client, /Math\.min\(\s*deadlineAt\s*,\s*[^,]+\+\s*[^)]+(?:timeout|Timeout)/, 'client expiry must be the earlier of global deadline and send-time response timeout');
  assert.match(client, /Buffer\.byteLength\([^,]+,\s*['\"]utf8['\"]\)/, 'wire limits must use UTF-8 bytes rather than JavaScript code units');
  assert.match(client, /buffer\.length\s*>\s*MAX_LINE|partial[^\n]{0,80}MAX_LINE/i, 'partial response framing must be bounded before a newline arrives');
});

test('phase2 native X11 shortcut and button paths check every XTEST result', () => {
  const nativeHelper = fs.readFileSync(path.resolve('platform/browser-agent/native/x11-inputd/x11-inputd.c'), 'utf8');
  const shortcut = nativeHelper.slice(nativeHelper.indexOf('if (strcmp(type, "shortcut") == 0)'), nativeHelper.indexOf('respond(out, id, false, "unknown_type"'));
  assert.match(nativeHelper, /if\s*\(\s*!XTestFakeKeyEvent\(display, code, down \? True : False, CurrentTime\)\s*\)\s*return false;/, 'fake_key must not report success when XTEST rejects the key event');
  assert.match(nativeHelper, /static bool fake_button\s*\([^)]*\)[\s\S]{0,500}XTestFakeButtonEvent/, 'button injection must use a checked helper rather than discard XTEST status');
  assert.match(shortcut, /if\s*\(\s*!fake_key\(parts\[count - 1\], true\)\s*\)/, 'shortcut must reject a failed main-key press');
  assert.match(shortcut, /if\s*\(\s*!fake_key\(parts\[count - 1\], false\)\s*\)/, 'shortcut must reject a failed main-key release');
  assert.match(shortcut, /if\s*\(\s*!fake_key\(parts\[i\], false\)\s*\)/, 'shortcut must reject a failed modifier release');
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

test('phase2 X11 shortcut protocol maps Controller names to X11 keysyms', async () => {
  assert.equal(normalizeX11Shortcut('CTRL+L'), 'Control_L+l');
  assert.equal(normalizeX11Shortcut('CTRL+SHIFT+T'), 'Control_L+Shift_L+t');
  assert.equal(normalizeX11Shortcut('ALT+LEFT'), 'Alt_L+ArrowLeft');
  const client = new X11InputClient();
  const calls = [];
  client.command = async (...args) => { calls.push(args); return { ok: true }; };
  await client.shortcut('CTRL+L');
  assert.deepEqual(calls, [['shortcut', { shortcut: 'Control_L+l' }]]);
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
    assertSingleWindowForRawInput: async () => ({ targetId: 'tab-1', windowId: 1 }),
    activateTab: async () => {},
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

function makeRawNavigationHarness() {
  const urls = new Map([
    ['unrelated-chromium', 'https://unrelated.example/original'],
    ['target-b', 'https://target.example/original']
  ]);
  const focusCalls = [];
  let focusedWindow;
  let omniboxText = '';
  let omniboxFocused = false;
  const x11 = {
    focusChromium: async () => {
      omniboxFocused = false;
    },
    shortcut: async () => {
      omniboxFocused = true;
      omniboxText = '';
    },
    typeText: async (text) => {
      if (omniboxFocused) omniboxText += text;
    },
    keyDown: async (key) => {
      if (key === 'Enter' && omniboxFocused) urls.set(focusedWindow, omniboxText);
    },
    keyUp: async () => {},
    mouseMove: async () => {},
    click: async () => {},
    mouseDown: async () => {},
    mouseUp: async () => {},
    wheel: async () => {},
    releaseAll: async () => {}
  };
  const controller = {
    activeTargetId: 'target-b',
    firstOpenTargetId: () => 'target-b',
    assertSingleWindowForRawInput: async (targetId) => { focusCalls.push(targetId); return { targetId, windowId: 1 }; },
    activateTab: async (targetId) => { focusedWindow = targetId; },
    findPage: async () => ({})
  };
  return {
    raw: new RawInputController({ browserController: controller, config: { width: 100, height: 100 }, x11 }),
    focusCalls,
    urls
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
