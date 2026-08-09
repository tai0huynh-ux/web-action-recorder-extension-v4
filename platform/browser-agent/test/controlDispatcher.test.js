import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlDispatcher } from '../src/controlDispatcher.js';
import { RawInputController } from '../src/rawInputController.js';
import { AgentError } from '../src/errors.js';

test('accepts valid envelope', async () => {
  const fake = makeFake();
  const dispatcher = makeDispatcher(fake);
  const result = await dispatcher.dispatch(envelope('browser.getState'));
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.browserState, 'running');
});

test('rejects wrong protocol', async () => {
  const dispatcher = makeDispatcher(makeFake());
  await assert.rejects(() => dispatcher.dispatch({ ...envelope('browser.getState'), protocol: 'bad' }), /Control envelope is invalid/);
});

test('rejects command past deadline', async () => {
  const dispatcher = makeDispatcher(makeFake(), () => Date.parse('2026-07-14T00:00:10.000Z'));
  await assert.rejects(() => dispatcher.dispatch(envelope('browser.getState', {}, { timestamp: '2026-07-14T00:00:00.000Z', deadlineMs: 1 })), /deadline/);
});

test('rejects unsupported type', async () => {
  const dispatcher = makeDispatcher(makeFake());
  await assert.rejects(() => dispatcher.dispatch(envelope('cdp.send')), /Unsupported command/);
});

test('duplicate mutating idempotency key does not run twice', async () => {
  const fake = makeFake();
  const dispatcher = makeDispatcher(fake);
  const request = envelope('tab.open', { url: 'https://example.com' }, { idempotencyKey: 'dup' });
  await dispatcher.dispatch(request);
  await dispatcher.dispatch(request);
  assert.equal(fake.openCount, 1);
});

test('URL scheme is blocked', async () => {
  const dispatcher = makeDispatcher(makeFake());
  await assert.rejects(() => dispatcher.dispatch(envelope('tab.open', { url: 'javascript:alert(1)' })), /Only http/);
});

test('URL credentials are blocked', async () => {
  const dispatcher = makeDispatcher(makeFake());
  await assert.rejects(() => dispatcher.dispatch(envelope('tab.open', { url: 'https://u:p@example.com' })), /credentials/);
});

test('browser-space raw input requires an explicit targetId', async () => {
  const fake = makeFake();
  const dispatcher = makeDispatcher(fake);
  await assert.rejects(
    () => dispatcher.dispatch(envelope('input.shortcut', { keys: 'CTRL+L', space: 'browser' })),
    /targetId/
  );
});

test('Chrome-like tab commands dispatch once to the exact controller method and payload', async () => {
  const fake = makeFake();
  const dispatcher = makeDispatcher(fake);
  const commands = [
    ['tab.new', { url: 'https://example.test/new' }, 'openTab', ['https://example.test/new']],
    ['tab.back', { targetId: 'tab-1' }, 'backTab', ['tab-1']],
    ['tab.forward', { targetId: 'tab-1' }, 'forwardTab', ['tab-1']],
    ['tab.reload', { targetId: 'tab-1' }, 'reloadTab', ['tab-1']],
    ['tab.home', { targetId: 'tab-1' }, 'homeTab', ['tab-1']],
    ['browser.openInternalPage', { page: 'settings' }, 'openInternalPage', ['settings']],
    ['browser.openInternalPage', { page: 'extensions' }, 'openInternalPage', ['extensions']],
  ];

  for (const [type, payload, method, args] of commands) {
    await dispatcher.dispatch(envelope(type, payload, { idempotencyKey: `${type}-${JSON.stringify(payload)}` }));
    assert.deepEqual(fake.calls.at(-1), [method, ...args]);
  }
  assert.equal(fake.calls.length, commands.length);
});

test('clipboard copy selection returns bounded text without logging or idempotency caching it', async () => {
  const fake = makeFake();
  const logs = [];
  const rawInput = {
    executeCompound: async (task) => task({
      execute: async (...args) => { fake.calls.push(['rawInput', ...args]); return { executed: true }; }
    })
  };
  const secret = 'synthetic clipboard secret';
  let reads = 0;
  const dispatcher = makeDispatcher(fake, undefined, (...args) => logs.push(args), rawInput, async () => { reads += 1; return secret; });

  const result = await dispatcher.dispatch(envelope('clipboard.copySelection'));
  await dispatcher.dispatch(envelope('clipboard.copySelection'));

  assert.deepEqual(fake.calls, [
    ['rawInput', 'input.shortcut', { targetId: 't1', keys: 'CTRL+C', space: 'browser' }],
    ['rawInput', 'input.shortcut', { targetId: 't1', keys: 'CTRL+C', space: 'browser' }],
  ]);
  assert.deepEqual(result.result, { copied: true, text: secret, bytes: Buffer.byteLength(secret, 'utf8') });
  assert.equal(reads, 2);
  assert.equal(JSON.stringify(logs).includes('synthetic clipboard secret'), false);
});

test('clipboard copy bounds the reader by remaining deadline and never returns plaintext after expiry', async () => {
  const timestamp = Date.parse('2026-07-14T00:00:00.000Z');
  let now = timestamp;
  const secret = 'expired clipboard plaintext';
  const readerOptions = [];
  const logs = [];
  const fake = makeFake();
  const rawInput = {
    executeCompound: async (task) => task({ execute: async () => ({ executed: true }) })
  };
  const dispatcher = makeDispatcher(
    fake,
    () => now,
    (...args) => logs.push(args),
    rawInput,
    async (options) => {
      readerOptions.push(options);
      now += 11;
      return secret;
    }
  );

  const outcome = await dispatcher.dispatch(envelope('clipboard.copySelection', {}, { deadlineMs: 10 }))
    .then(() => undefined, (error) => error);

  assert.equal(readerOptions.length, 1);
  assert.equal(readerOptions[0].timeoutMs, 10, 'xclip reader must receive only the remaining command time');
  assert.equal(outcome?.code, 'deadline_exceeded');
  assert.equal(JSON.stringify({ outcome, logs }).includes(secret), false);
});

test('clipboard paste runs guard and sends Ctrl+V through the exact browser target before selection completion', async () => {
  const fake = makeFake();
  const secret = 'one-time secret';
  const events = [];
  const shortcutCalls = [];
  const completion = deferred();
  const rawInput = {
    executeCompound: async (task) => task({
      execute: async (type, payload) => {
        shortcutCalls.push({ type, payload });
        events.push(type === 'browser.focusWindow' ? 'focusWindow' : `shortcut:${type}:${payload.keys}`);
        if (type === 'input.shortcut') {
          completion.resolve({ written: true, bytes: Buffer.byteLength(secret, 'utf8') });
          events.push('selection:completed');
        }
        return { executed: true };
      }
    })
  };
  fake.controller.assertSingleWindowForRawInput = async () => { events.push('guard'); return { targetId: 't1', windowId: 1 }; };
  const helperCalls = [];
  const logs = [];
  const dispatcher = makeDispatcher(fake, undefined, (...args) => logs.push(args), rawInput, undefined, async (value) => {
    helperCalls.push(value);
    events.push('helper:ready');
    return {
      waitForPaste: async () => { events.push('selection:armed'); return completion.promise; },
      abort: async () => { events.push('session:abort'); completion.reject(new Error('aborted')); }
    };
  });

  const result = await dispatcher.dispatch(envelope('clipboard.pasteText', { text: secret }));

  assert.deepEqual(events, [
    'guard',
    'helper:ready',
    'selection:armed',
    'focusWindow',
    'shortcut:input.shortcut:CTRL+V',
    'selection:completed'
  ]);
  assert.deepEqual(shortcutCalls, [
    { type: 'browser.focusWindow', payload: { targetId: 't1' } },
    { type: 'input.shortcut', payload: { targetId: 't1', keys: 'CTRL+V', space: 'browser' } }
  ], 'clipboard paste must refocus the browser and use the native input space');
  assert.deepEqual(helperCalls, [secret], 'the one-shot owner must not immediately rewrite the clipboard');
  assert.deepEqual(result.result, { pasted: true, bytes: Buffer.byteLength(secret, 'utf8') });
  assert.equal(JSON.stringify({ result, logs, events }).includes(secret), false);
});

test('clipboard paste uses browser-space Ctrl+V when the omnibox owns focus', async () => {
  const fake = makeFake();
  const calls = [];
  let omniboxFocused = true;
  const rawInput = {
    executeCompound: async (task) => task({
      execute: async (type, payload) => {
        calls.push({ type, payload });
        if (type === 'input.shortcut' && omniboxFocused && payload.space !== 'browser') {
          throw new Error('CDP viewport input cannot reach a focused browser omnibox');
        }
        return { executed: true };
      }
    })
  };
  const dispatcher = makeDispatcher(fake, undefined, undefined, rawInput, undefined, async () => ({
    waitForPaste: async () => ({ written: true }),
    abort: async () => {}
  }));

  await dispatcher.dispatch(envelope('clipboard.pasteText', { text: 'omnibox paste' }));

  assert.deepEqual(calls, [
    { type: 'browser.focusWindow', payload: { targetId: 't1' } },
    { type: 'input.shortcut', payload: { targetId: 't1', keys: 'CTRL+V', space: 'browser' } }
  ], 'focused omnibox paste must refocus Chrome and use the native browser input space');
});

test('rejects a clipboard command that expires while waiting in the raw-input queue before it causes effects', async () => {
  const timestamp = Date.parse('2026-07-14T00:00:00.000Z');
  let now = timestamp;
  const entered = deferred();
  const release = deferred();
  const effects = [];
  const clipboardWrites = [];
  const controller = {
    activeTargetId: 'tab-1',
    firstOpenTargetId: () => 'tab-1',
    assertSingleWindowForRawInput: async () => ({ targetId: 'tab-1', windowId: 1 }),
    activateTab: async () => { effects.push('focus'); return { targetId: 'tab-1' }; },
    findPage: async () => ({}),
    focusActiveTab: async () => { effects.push('focus'); return { targetId: 'tab-1' }; }
  };
  const x11 = {
    focusChromium: async () => { effects.push('x11-focus'); },
    shortcut: async () => { effects.push('shortcut'); entered.resolve(); await release.promise; },
    typeText: async () => { effects.push('type-text'); },
    mouseMove: async () => {},
    clickAt: async () => {},
    mouseDown: async () => {},
    mouseUp: async () => {},
    wheel: async () => {},
    keyDown: async () => {},
    keyUp: async () => {},
    releaseAll: async () => {}
  };
  const rawInput = new RawInputController({ browserController: controller, config: { width: 100, height: 100 }, x11 });
  const dispatcher = new ControlDispatcher({
    supervisor: { getBrowserState: async () => ({ browserState: 'running' }) },
    controller,
    deviceId: 'device-1',
    now: () => now,
    rawInputController: rawInput,
    clipboardWriter: async (text) => { clipboardWrites.push(text); }
  });

  const blocker = rawInput.execute('input.shortcut', { targetId: 'tab-1', keys: 'CTRL+L', space: 'browser' });
  await entered.promise;
  const effectsBeforeCommand = [...effects];
  const pending = dispatcher.dispatch(envelope('clipboard.pasteText', { text: 'do-not-paste' }, { deadlineMs: 1 }));
  now += 2;
  release.resolve();
  await blocker;

  const failure = await pending.then(() => undefined, (error) => error);
  assert.equal(failure?.code, 'deadline_exceeded');
  assert.deepEqual(effects, effectsBeforeCommand);
  assert.deepEqual(clipboardWrites, [], 'queue-deadline rejection must occur before writing the X11 clipboard');
});

test('clipboard paste aborts the sensitive owner when its deadline expires after helper readiness', async () => {
  const timestamp = Date.parse('2026-07-14T00:00:00.000Z');
  let now = timestamp;
  const fake = makeFake();
  const events = [];
  const pasteCompletion = deferred();
  fake.controller.assertSingleWindowForRawInput = async () => { events.push('guard'); return { targetId: 't1', windowId: 1 }; };
  const rawInput = {
    executeCompound: async (task, { deadlineAt, now: commandNow }) => task({
      execute: async () => {
        if (deadlineAt < commandNow()) throw new AgentError('deadline_exceeded', 'Command deadline has already passed', 408);
        events.push('x11');
      }
    })
  };
  const dispatcher = makeDispatcher(fake,
    () => now,
    undefined,
    rawInput,
    undefined,
    async () => {
      events.push('helper:ready');
      now += 2;
      return {
        waitForPaste: async () => { events.push('selection:armed'); return pasteCompletion.promise; },
        abort: async () => { events.push('session:abort'); pasteCompletion.reject(new Error('aborted')); }
      };
    });

  await assert.rejects(
    () => dispatcher.dispatch(envelope('clipboard.pasteText', { text: 'stale clipboard' }, { deadlineMs: 1 })),
    (error) => error?.code === 'deadline_exceeded'
  );
  assert.deepEqual(events, ['guard', 'helper:ready', 'selection:armed', 'session:abort']);
});

test('clipboard paste aborts the sensitive owner when the post-owner popup guard fails without XTEST', async () => {
  const fake = makeFake();
  const events = [];
  const pasteCompletion = deferred();
  fake.controller.assertSingleWindowForRawInput = async () => { events.push('guard'); return { targetId: 't1', windowId: 1 }; };
  const rawInput = {
    executeCompound: async (task) => task({
      execute: async () => {
        throw new AgentError('raw_input_window_ambiguous', 'Selected target resolves to multiple browser windows', 409);
      }
    })
  };
  const dispatcher = makeDispatcher(fake, undefined, undefined, rawInput, undefined, async () => {
    events.push('helper:ready');
    return {
      waitForPaste: async () => { events.push('selection:armed'); return pasteCompletion.promise; },
      abort: async () => { events.push('session:abort'); pasteCompletion.reject(new Error('aborted')); }
    };
  });

  await assert.rejects(
    () => dispatcher.dispatch(envelope('clipboard.pasteText', { text: 'popup race' })),
    (error) => error?.code === 'raw_input_window_ambiguous'
  );
  assert.deepEqual(events, ['guard', 'helper:ready', 'selection:armed', 'session:abort']);
});

test('clipboard paste fails closed before helper ownership when atomic queue or window guard is unavailable', async () => {
  const fake = makeFake();
  const helperCalls = [];
  const unavailableQueue = makeDispatcher(fake, undefined, undefined, { execute: async () => {} }, undefined, async (text) => helperCalls.push(text));
  await assert.rejects(
    () => unavailableQueue.dispatch(envelope('clipboard.pasteText', { text: 'never owned' })),
    (error) => error?.code === 'raw_input_unavailable'
  );

  const missingGuard = makeFake();
  delete missingGuard.controller.assertSingleWindowForRawInput;
  const unavailableGuard = makeDispatcher(missingGuard, undefined, undefined, { executeCompound: async () => {} }, undefined, async (text) => helperCalls.push(text));
  await assert.rejects(
    () => unavailableGuard.dispatch(envelope('clipboard.pasteText', { text: 'also never owned' })),
    (error) => error?.code === 'raw_input_unavailable'
  );

  assert.deepEqual(helperCalls, [], 'the sensitive owner must not start without atomic input and a single-window guard');
});

function makeDispatcher(fake, now = () => Date.parse('2026-07-14T00:00:00.000Z'), log = () => {}, rawInputController, clipboardReader, clipboardWriter) {
  return new ControlDispatcher({ supervisor: fake.supervisor, controller: fake.controller, deviceId: 'device-1', now, log, rawInputController, clipboardReader, clipboardWriter });
}

function envelope(type, payload = {}, overrides = {}) {
  return {
    protocol: 'war-control.v1',
    messageId: 'msg-1',
    type,
    deviceId: 'device-1',
    timestamp: '2026-07-14T00:00:00.000Z',
    deadlineMs: 60000,
    idempotencyKey: `${type}-key`,
    payload,
    ...overrides
  };
}

function makeFake() {
  const fake = { openCount: 0, calls: [] };
  fake.supervisor = {
    getBrowserState: async () => ({ browserState: 'running' }),
    start: async () => ({ browserState: 'running' }),
    stop: async () => ({ browserState: 'stopped' }),
    restart: async () => ({ browserState: 'running' })
  };
  fake.controller = {
    activeTargetId: 't1',
    firstOpenTargetId: () => 't1',
    assertSingleWindowForRawInput: async () => ({ targetId: 't1', windowId: 1 }),
    listTabs: async () => [],
    openTab: async (...args) => {
      fake.openCount += 1;
      fake.calls.push(['openTab', ...args]);
      return { targetId: 't1' };
    },
    activateTab: async (...args) => { fake.calls.push(['activateTab', ...args]); return { targetId: 't1' }; },
    navigateTab: async (...args) => { fake.calls.push(['navigateTab', ...args]); return { targetId: 't1' }; },
    closeTab: async (...args) => { fake.calls.push(['closeTab', ...args]); return { closed: true }; },
    backTab: async (...args) => { fake.calls.push(['backTab', ...args]); return { targetId: 't1' }; },
    forwardTab: async (...args) => { fake.calls.push(['forwardTab', ...args]); return { targetId: 't1' }; },
    reloadTab: async (...args) => { fake.calls.push(['reloadTab', ...args]); return { targetId: 't1' }; },
    homeTab: async (...args) => { fake.calls.push(['homeTab', ...args]); return { targetId: 't1' }; },
    openInternalPage: async (...args) => { fake.calls.push(['openInternalPage', ...args]); return { targetId: 't1' }; },
    focusActiveTab: async () => { fake.calls.push(['focusActiveTab']); return { targetId: 't1' }; },
  };
  return fake;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((next, fail) => { resolve = next; reject = fail; });
  return { promise, resolve, reject };
}
