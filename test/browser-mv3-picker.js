#!/usr/bin/env node
import http from 'node:http';
import {
  EXTENSION_PATH,
  captureScreenshot,
  click,
  createTrace,
  detectExtensionOrBlock,
  evaluate,
  finish,
  finishFailureWithScreenshot,
  launchBrowser,
  mouseClick,
  mouseMove,
  near,
  openExtensionEditor,
  openTarget,
  safeRemove,
  selectBrowser,
  setViewport,
  step,
  waitFor,
  waitForExpression
} from './browser-mv3-harness.js';

const trace = createTrace('picker');
let activePage = null;
let fixtureServer = null;

async function main() {
  const browser = selectBrowser({ requested: 'edge' });
  trace.browserName = browser.name;
  trace.browserExecutablePath = browser.path;
  step(trace, 'Selected browser', `${browser.name}: ${browser.path}`);

  const fixture = await startFixtureServer();
  fixtureServer = fixture.server;
  step(trace, 'Started fixture server', fixture.url);

  const run = await launchBrowser(browser.path, EXTENSION_PATH);
  trace.browserVersion = run.version;
  step(trace, 'Launched browser', `${run.version}; remote debugging port ${run.port}`);

  try {
    const detected = await detectExtensionOrBlock({ trace, browser, run });
    if (!detected.ok) return finish(trace, 'Blocked', detected.reason, 2);

    const web = await openTarget(run.port, fixture.url);
    activePage = web;
    await web.send('Runtime.enable');
    await web.send('Page.enable');
    await waitForExpression(web, 'document.readyState === "complete"');

    const editor = await openExtensionEditor(run.port, trace.extensionId);
    step(trace, 'Opened editor and fixture', `editor=${trace.extensionId}; fixture=${fixture.url}`);

    await createClickNode(editor);
    await acceptFlow({ editor, web });
    await cancelFlow({ editor, web });
    await escapeFlow({ editor, web });
    await scrollAndResizeFlow({ editor, web });
    await repeatedCleanupFlow({ editor, web, iterations: 20 });

    await captureScreenshot(web, trace);
    return finish(trace, 'Pass', 'Picker lifecycle and selector persistence passed.', 0);
  } finally {
    run.close();
    safeRemove(run.userDataDir);
    await closeFixtureServer();
  }
}

async function createClickNode(editor) {
  await click(editor, '#newProfileBtn');
  await waitForExpression(editor, 'document.querySelector("#profileName").value.length > 0');
  await evaluate(editor, `
    document.querySelector('#profileName').value = 'Browser MV3 picker';
    document.querySelector('#profileName').dispatchEvent(new Event('input', { bubbles: true }));
  `);
  await click(editor, '[data-add="click"]');
  await waitForExpression(editor, 'document.querySelectorAll(".canvas-node").length === 1');
}

async function acceptFlow({ editor, web }) {
  await startPicker(editor, web);
  await mouseClickSelector(web, '#stable-action');
  await waitForExpression(web, 'window.__warPickerState().chooserCount === 1');
  await clickCandidate(web, 'Stable Action');
  const beforeAccept = await selectorValue(editor);
  const preview = await pickerPreviewSelector(web);
  if (beforeAccept) throw new Error(`Picker preview modified editor selector before accept: ${beforeAccept}`);
  if (preview !== '#stable-action') throw new Error(`Expected preview selector #stable-action, got ${preview}`);
  await clickChooserAction(web, 'accept');
  await waitForPickerGone(web);
  await waitForExpression(editor, 'document.querySelector("[data-k=\\"selector\\"]").value === "#stable-action"');
  await click(editor, '#saveBtn');
  await editor.send('Page.reload', { ignoreCache: true });
  await waitForExpression(editor, 'document.querySelector("[data-k=\\"selector\\"]").value === "#stable-action"');
  step(trace, 'Picker accept flow passed', 'Preview did not mutate editor until accept; #stable-action persisted after reload.');
}

async function cancelFlow({ editor, web }) {
  const original = await selectorValue(editor);
  await startPicker(editor, web);
  await mouseClickSelector(web, '#nested-target');
  await waitForExpression(web, 'window.__warPickerState().chooserCount === 1');
  await clickChooserAction(web, 'cancel');
  await waitForPickerGone(web);
  const after = await selectorValue(editor);
  if (after !== original) throw new Error(`Cancel changed selector from ${original} to ${after}`);
  step(trace, 'Picker cancel flow passed', 'Cancel left selector unchanged and removed picker UI.');
}

async function escapeFlow({ editor, web }) {
  const original = await selectorValue(editor);
  await startPicker(editor, web);
  await web.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' });
  await web.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape' });
  await waitForPickerGone(web);
  const after = await selectorValue(editor);
  if (after !== original) throw new Error(`Escape changed selector from ${original} to ${after}`);
  step(trace, 'Picker Escape flow passed', 'Escape left selector unchanged and removed picker UI.');
}

async function scrollAndResizeFlow({ editor, web }) {
  await startPicker(editor, web);
  await mouseMoveToSelector(web, '#scroll-target');
  await waitForExpression(web, 'window.__warPickerState().targetBoxVisible');
  const before = await targetAndBoxRects(web, '#scroll-target');
  step(trace, 'Picker scroll/resize pre-scroll', JSON.stringify(before));
  if (!near(before.box, before.target, 4)) throw new Error(`Target box was not aligned before scroll: ${JSON.stringify(before)}`);

  await web.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: before.target.x + 8,
    y: before.target.y + 8,
    deltaY: 420,
    deltaX: 0
  });
  await waitForExpression(web, 'window.scrollY > 0');
  await setViewport(web, 1100, 760);
  await mouseMoveToSelector(web, '#scroll-target');
  let lastRects = null;
  try {
    await waitFor(async () => {
      lastRects = await targetAndBoxRects(web, '#scroll-target');
      return near(lastRects.box, lastRects.target, 6) ? lastRects : null;
    }, 5000, 'target box to follow scroll/resize');
  } catch (error) {
    step(trace, 'Picker scroll/resize diagnostic', JSON.stringify(lastRects));
    throw error;
  }
  await web.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' });
  await web.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape' });
  await waitForPickerGone(web);
  step(trace, 'Picker scroll/resize flow passed', 'Target box stayed aligned after scroll and viewport resize.');
}

async function repeatedCleanupFlow({ editor, web, iterations }) {
  const original = await selectorValue(editor);
  for (let index = 0; index < iterations; index += 1) {
    await startPicker(editor, web);
    await mouseClickSelector(web, '#stable-action');
    await waitForExpression(web, 'window.__warPickerState().chooserCount === 1');
    await clickChooserAction(web, 'cancel');
    await waitForPickerGone(web);
    const state = await pickerState(web);
    if (state.chooserCount || state.overlayCount || state.targetBoxCount) {
      throw new Error(`Picker UI leaked after iteration ${index + 1}: ${JSON.stringify(state)}`);
    }
  }
  const after = await selectorValue(editor);
  if (after !== original) throw new Error(`Repeated cleanup changed selector from ${original} to ${after}`);
  step(trace, 'Picker repeated cleanup passed', `${iterations} cancel iterations left no duplicate picker UI.`);
}

async function startPicker(editor, web) {
  await installPickerStateProbe(web);
  await editor.send('Page.bringToFront').catch(() => {});
  await mouseClickSelector(editor, '.pick-target');
  await waitForExpression(web, 'window.__warPickerState && window.__warPickerState().overlayCount === 1');
  const state = await pickerState(web);
  if (state.chooserCount !== 0 || state.overlayCount !== 1) throw new Error(`Unexpected picker start state: ${JSON.stringify(state)}`);
}

async function installPickerStateProbe(web) {
  await evaluate(web, `
    window.__warPickerState = () => {
      const fixed = [...document.documentElement.querySelectorAll('*')].filter((el) => getComputedStyle(el).position === 'fixed');
      const overlays = fixed.filter((el) => getComputedStyle(el).backgroundColor === 'rgb(36, 92, 255)' && getComputedStyle(el).pointerEvents === 'none');
      const targetBoxes = fixed.filter((el) => el.style.zIndex === '2147483646' && el.style.border.includes('rgb(36, 92, 255)'));
      const choosers = fixed.filter((el) => {
        const buttons = [...el.querySelectorAll('button')];
        return el.style.zIndex === '2147483647' && buttons.length >= 3 && el.querySelector('code');
      });
      return {
        overlayCount: overlays.length,
        targetBoxCount: targetBoxes.length,
        targetBoxVisible: targetBoxes.some((el) => getComputedStyle(el).display !== 'none'),
        chooserCount: choosers.length,
        preview: choosers[0]?.querySelector('code')?.textContent || '',
        chooserTexts: choosers.map((el) => el.textContent)
      };
    };
  `);
}

async function pickerState(web) {
  await installPickerStateProbe(web);
  return evaluate(web, 'window.__warPickerState()');
}

async function waitForPickerGone(web) {
  await waitForExpression(web, 'window.__warPickerState().overlayCount === 0 && window.__warPickerState().chooserCount === 0 && window.__warPickerState().targetBoxCount === 0');
}

async function pickerPreviewSelector(web) {
  return evaluate(web, 'window.__warPickerState().preview');
}

async function clickCandidate(web, labelPart) {
  const point = await evaluate(web, `
    (() => {
      const chooser = [...document.documentElement.querySelectorAll('*')].find((el) => {
        const buttons = [...el.querySelectorAll('button')];
        return getComputedStyle(el).position === 'fixed' && buttons.length >= 3 && el.querySelector('code');
      });
      const button = [...chooser.querySelectorAll('button')].find((item) => item.textContent.includes(${JSON.stringify(labelPart)}));
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()
  `);
  await mouseClick(web, point.x, point.y);
}

async function clickChooserAction(web, action) {
  const point = await evaluate(web, `
    (() => {
      const chooser = [...document.documentElement.querySelectorAll('*')].find((el) => {
        const buttons = [...el.querySelectorAll('button')];
        return getComputedStyle(el).position === 'fixed' && buttons.length >= 3 && el.querySelector('code');
      });
      const buttons = [...chooser.querySelectorAll('button')];
      const button = buttons[${action === 'accept' ? 'buttons.length - 1' : 'buttons.length - 2'}];
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()
  `);
  await mouseClick(web, point.x, point.y);
}

async function selectorValue(editor) {
  return evaluate(editor, 'document.querySelector("[data-k=\\"selector\\"]")?.value || ""');
}

async function mouseClickSelector(page, selector) {
  const point = await centerOf(page, selector);
  await mouseClick(page, point.x, point.y);
}

async function mouseMoveToSelector(page, selector) {
  const point = await centerOf(page, selector);
  await mouseMove(page, point.x, point.y);
}

async function centerOf(page, selector) {
  return evaluate(page, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Missing selector: ${selector}');
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()
  `);
}

async function targetAndBoxRects(web, targetSelector) {
  return evaluate(web, `
    (() => {
      const targetRect = document.querySelector(${JSON.stringify(targetSelector)}).getBoundingClientRect();
      const box = [...document.documentElement.querySelectorAll('*')].find((el) => el.style.zIndex === '2147483646' && getComputedStyle(el).display !== 'none');
      const boxRect = box.getBoundingClientRect();
      return {
        target: { x: targetRect.left, y: targetRect.top },
        box: { x: boxRect.left, y: boxRect.top }
      };
    })()
  `);
}

async function startFixtureServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>WAR Picker Fixture</title>
  <style>
    body { font-family: Arial, sans-serif; min-height: 2200px; padding: 40px; }
    .panel { margin-top: 24px; padding: 20px; border: 1px solid #ccd3df; }
    #scroll-target { margin-top: 1100px; display: inline-block; padding: 14px 18px; border: 2px solid #245cff; }
  </style>
</head>
<body>
  <h1>Picker fixture</h1>
  <button id="stable-action">Stable Action</button>
  <input id="search-input" placeholder="Stable placeholder">
  <div class="panel">
    <button id="nested-target"><span><strong>Nested</strong> Action Text</span></button>
    <p id="nested-text"><span>Nested readable text target</span></p>
  </div>
  <button id="scroll-target">Scroll Target</button>
</body>
</html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/fixture` };
}

async function closeFixtureServer() {
  if (!fixtureServer) return;
  await new Promise((resolve) => fixtureServer.close(resolve));
  fixtureServer = null;
}

try {
  await main();
} catch (error) {
  await closeFixtureServer();
  await finishFailureWithScreenshot({ trace, page: activePage, error });
}
