#!/usr/bin/env node
import { createServer } from 'node:http';
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
  openExtensionEditor,
  openTarget,
  safeRemove,
  selectBrowser,
  step,
  waitForExpression
} from './browser-mv3-harness.js';

const trace = createTrace('roots');
let activePage = null;

async function main() {
  const browser = selectBrowser();
  trace.browserName = browser.name;
  trace.browserExecutablePath = browser.path;
  step(trace, 'Selected browser', `${browser.name}: ${browser.path}`);

  const server = await startFixtureServer();
  const run = await launchBrowser(browser.path, EXTENSION_PATH);
  trace.browserVersion = run.version;
  step(trace, 'Launched browser', `${run.version}; remote debugging port ${run.port}`);

  try {
    const detected = await detectExtensionOrBlock({ trace, browser, run });
    if (!detected.ok) return finish(trace, 'Blocked', detected.reason, 2);

    const target = await openTarget(run.port, server.url);
    await target.send('Runtime.enable');
    await target.send('Page.enable');
    await waitForExpression(target, 'document.readyState === "complete"');
    step(trace, 'Opened run target', server.url);

    const page = await openExtensionEditor(run.port, trace.extensionId);
    activePage = page;
    step(trace, 'Opened editor page', `chrome-extension://${trace.extensionId}/ui/sidepanel.html?standalone=1`);

    await createLogProfile(page);
    await layoutNodes(page);
    await connectByIndex(page, 0, 1, 1);
    await connectByIndex(page, 2, 3, 2);
    await click(page, '#discoverRootsBtn');
    await verifyRoots(page, ['A', 'C']);

    await connectByIndex(page, 1, 2, 3);
    await verifyRoots(page, ['A']);

    await removeLatestLink(page);
    await verifyRoots(page, ['A', 'C']);

    await click(page, '#saveBtn');
    await waitForSavedTwoChains(page);
    await page.send('Page.reload', { ignoreCache: true });
    await waitForExpression(page, 'document.querySelectorAll(".canvas-node").length === 4');
    await verifyRoots(page, ['A', 'C']);

    await activateTargetAndRun(page, target);
    const observed = await waitForRunOrder(page);
    trace.executionOrder = observed;
    if (observed.join(',') !== 'A,B,C,D') throw new Error(`Unexpected log order: ${observed.join(', ')}`);
    if (new Set(observed).size !== 4) throw new Error(`A node executed more than once: ${observed.join(', ')}`);

    await captureScreenshot(page, trace);
    return finish(trace, 'Pass', `Root discovery and run order passed: ${observed.join(', ')}`, 0);
  } finally {
    server.close();
    run.close();
    safeRemove(run.userDataDir);
  }
}

async function createLogProfile(page) {
  await click(page, '#newProfileBtn');
  await evaluate(page, `
    document.querySelector('#profileName').value = 'Browser MV3 roots';
    document.querySelector('#profileName').dispatchEvent(new Event('input', { bubbles: true }));
  `);
  for (const name of ['A', 'B', 'C', 'D']) await addLogNode(page, name);
  await waitForExpression(page, 'document.querySelectorAll(".canvas-node").length === 4');
}

async function addLogNode(page, name) {
  await click(page, '[data-add="log"]');
  await evaluate(page, `
    (() => {
      const node = [...document.querySelectorAll('.canvas-node')].at(-1);
      node.querySelector('[data-k="name"]').value = ${JSON.stringify(name)};
      node.querySelector('[data-k="name"]').dispatchEvent(new Event('input', { bubbles: true }));
      node.querySelector('[data-k="message"]').value = ${JSON.stringify(name)};
      node.querySelector('[data-k="message"]').dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
}

async function connectByIndex(page, fromIndex, toIndex, expectedLinkCount) {
  const points = await evaluate(page, `
    (() => {
      const nodes = document.querySelectorAll('.canvas-node');
      const out = nodes[${fromIndex}].querySelector('.out-port').getBoundingClientRect();
      const input = nodes[${toIndex}].querySelector('.in-port').getBoundingClientRect();
      return {
        out: { x: out.left + out.width / 2, y: out.top + out.height / 2 },
        input: { x: input.left + input.width / 2, y: input.top + input.height / 2 }
      };
    })()
  `);
  await mouseClick(page, points.out.x, points.out.y);
  await mouseClick(page, points.input.x, points.input.y);
  await waitForExpression(page, `document.querySelectorAll(".canvas-link").length === ${expectedLinkCount}`);
}

async function layoutNodes(page) {
  await evaluate(page, `
    (() => {
      const positions = [{ x: 80, y: 80 }, { x: 460, y: 80 }, { x: 80, y: 320 }, { x: 460, y: 320 }];
      globalThis.__warEditor.nodes.forEach((node, index) => { node.ui = positions[index]; });
      globalThis.__warEditor.render();
      globalThis.__warEditor.onStateChange();
    })()
  `);
  await waitForExpression(page, `
    [...document.querySelectorAll('.canvas-node')].every((node, index) => {
      const positions = [{ x: 80, y: 80 }, { x: 460, y: 80 }, { x: 80, y: 320 }, { x: 460, y: 320 }];
      const match = node.style.transform.match(/translate\\(([-0-9.]+)px,\\s*([-0-9.]+)px\\)/);
      return Math.abs(Number(match[1]) - positions[index].x) <= 1 && Math.abs(Number(match[2]) - positions[index].y) <= 1;
    })
  `);
}

async function removeLatestLink(page) {
  await evaluate(page, `
    (() => {
      const links = document.querySelectorAll('.canvas-link');
      const link = links[links.length - 1];
      link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window }));
    })()
  `);
  await waitForExpression(page, 'document.querySelectorAll(".canvas-link").length === 2');
}

async function verifyRoots(page, expected) {
  const expression = `
    (() => {
      const roots = [...document.querySelectorAll('.canvas-node.root-node')]
        .map(node => node.querySelector('[data-k="name"]').value)
        .sort();
      return JSON.stringify(roots) === ${JSON.stringify(JSON.stringify([...expected].sort()))};
    })()
  `;
  try {
    await waitForExpression(page, expression);
  } catch (error) {
    const actual = await evaluate(page, `
      (() => ({
        roots: [...document.querySelectorAll('.canvas-node.root-node')].map(node => node.querySelector('[data-k="name"]').value).sort(),
        status: document.querySelector('#rootStatus')?.textContent || '',
        links: globalThis.__warEditor?.nodes?.map(step => ({ name: step.name, next: step.next || null })) || []
      }))()
    `);
    throw new Error(`Expected roots ${expected.join(', ')} but saw ${JSON.stringify(actual)}: ${error.message}`);
  }
  const status = await evaluate(page, 'document.querySelector("#rootStatus").textContent');
  if (!status.includes(String(expected.length))) throw new Error(`Root status did not show ${expected.length}: ${status}`);
  step(trace, 'Verified roots', expected.join(', '));
}

async function waitForSavedTwoChains(page) {
  await waitForExpression(page, `
    (async () => {
      const data = await chrome.storage.local.get(['war_profiles', 'war_active_profile_id']);
      const profile = data.war_profiles.find((item) => item.id === data.war_active_profile_id);
      return (
        profile.steps.find(step => step.name === 'A')?.next === profile.steps.find(step => step.name === 'B')?.id &&
        profile.steps.find(step => step.name === 'C')?.next === profile.steps.find(step => step.name === 'D')?.id &&
        !profile.steps.find(step => step.name === 'B')?.next
      );
    })()
  `);
}

async function activateTargetAndRun(page, target) {
  await evaluate(page, `
    (async () => {
      const tabs = await chrome.tabs.query({ url: ${JSON.stringify(serverUrlPattern())} });
      if (!tabs[0]) throw new Error('Run target tab not found');
      await chrome.tabs.update(tabs[0].id, { active: true });
      await chrome.windows.update(tabs[0].windowId, { focused: true });
      const result = await chrome.runtime.sendMessage({ type: 'RUN_PROFILE', profileId: document.querySelector('#profileSelect').value });
      if (!result?.ok) throw new Error(result?.error || 'Run failed to start');
    })()
  `);
  void target;
}

async function waitForRunOrder(page) {
  return waitForExpression(page, `
    (async () => {
      const data = await chrome.storage.local.get('war_logs');
      const logs = (data.war_logs || []).filter(log => ['A','B','C','D'].includes(log.message));
      const ordered = logs.slice().reverse().map(log => log.message);
      return ordered.length === 4 && new Set(ordered).size === 4 ? ordered : false;
    })()
  `, 15000);
}

function serverUrlPattern() {
  return `${globalThis.__warRootsServerUrl}*`;
}

async function startFixtureServer() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>WAR roots target</title><main>roots target</main>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  globalThis.__warRootsServerUrl = url;
  return {
    url,
    close: () => server.close()
  };
}

try {
  await main();
} catch (error) {
  await finishFailureWithScreenshot({ trace, page: activePage, error });
}
