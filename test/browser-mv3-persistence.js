#!/usr/bin/env node
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
  near,
  openExtensionEditor,
  safeRemove,
  selectBrowser,
  step,
  waitForExpression
} from './browser-mv3-harness.js';

const trace = createTrace('persistence');
let activePage = null;

async function main() {
  const browser = selectBrowser();
  trace.browserName = browser.name;
  trace.browserExecutablePath = browser.path;
  step(trace, 'Selected browser', `${browser.name}: ${browser.path}`);

  const run = await launchBrowser(browser.path, EXTENSION_PATH);
  trace.browserVersion = run.version;
  step(trace, 'Launched browser', `${run.version}; remote debugging port ${run.port}`);

  try {
    const detected = await detectExtensionOrBlock({ trace, browser, run });
    if (!detected.ok) return finish(trace, 'Blocked', detected.reason, 2);

    const page = await openExtensionEditor(run.port, trace.extensionId);
    activePage = page;
    step(trace, 'Opened editor page', `chrome-extension://${trace.extensionId}/ui/sidepanel.html?standalone=1`);

    await createTwoNodeProfile(page);
    await moveNodeTo(page, 1, { x: 80, y: 80 });
    await moveNodeTo(page, 0, { x: 460, y: 240 });
    await connectNodes(page);
    await click(page, '#saveBtn');
    step(trace, 'Created and saved graph', 'Two nodes moved to known canvas positions and connected.');

    await page.send('Page.reload', { ignoreCache: true });
    await waitForExpression(page, 'document.querySelectorAll(".canvas-node").length === 2');
    await verifyPersistence(page);
    await captureScreenshot(page, trace);
    return finish(trace, 'Pass', 'Node position and link persistence passed.', 0);
  } finally {
    run.close();
    safeRemove(run.userDataDir);
  }
}

async function createTwoNodeProfile(page) {
  await click(page, '#newProfileBtn');
  await waitForExpression(page, 'document.querySelector("#profileName").value.length > 0');
  await evaluate(page, `
    document.querySelector('#profileName').value = 'Browser MV3 persistence';
    document.querySelector('#profileName').dispatchEvent(new Event('input', { bubbles: true }));
  `);
  await click(page, '[data-add="click"]');
  await click(page, '[data-add="log"]');
  await waitForExpression(page, 'document.querySelectorAll(".canvas-node").length === 2');
}

async function moveNodeTo(page, nodeIndex, target) {
  const current = await evaluate(page, `
    (() => {
      const node = document.querySelectorAll('.canvas-node')[${nodeIndex}];
      const header = node.querySelector('.node-header');
      const transform = node.style.transform.match(/translate\\(([-0-9.]+)px,\\s*([-0-9.]+)px\\)/);
      const rect = header.getBoundingClientRect();
      return {
        x: Number(transform[1]),
        y: Number(transform[2]),
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      };
    })()
  `);
  const dx = target.x - current.x;
  const dy = target.y - current.y;
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: current.clientX, y: current.clientY, button: 'left' });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: current.clientX, y: current.clientY, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: current.clientX + dx, y: current.clientY + dy, button: 'left' });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: current.clientX + dx, y: current.clientY + dy, button: 'left', clickCount: 1 });
  await waitForExpression(page, `(() => {
    const node = document.querySelectorAll('.canvas-node')[${nodeIndex}];
    const match = node.style.transform.match(/translate\\(([-0-9.]+)px,\\s*([-0-9.]+)px\\)/);
    return Math.abs(Number(match[1]) - ${target.x}) <= 1 && Math.abs(Number(match[2]) - ${target.y}) <= 1;
  })()`);
}

async function connectNodes(page) {
  const points = await evaluate(page, `
    (() => {
      const nodes = document.querySelectorAll('.canvas-node');
      const out = nodes[0].querySelector('.out-port').getBoundingClientRect();
      const input = nodes[1].querySelector('.in-port').getBoundingClientRect();
      return {
        out: { x: out.left + out.width / 2, y: out.top + out.height / 2 },
        input: { x: input.left + input.width / 2, y: input.top + input.height / 2 }
      };
    })()
  `);
  await mouseClick(page, points.out.x, points.out.y);
  await mouseClick(page, points.input.x, points.input.y);
  await waitForExpression(page, 'document.querySelectorAll(".canvas-link").length === 1');
}

async function verifyPersistence(page) {
  const result = await evaluate(page, `
    (async () => {
      const nodes = [...document.querySelectorAll('.canvas-node')];
      const data = await chrome.storage.local.get(['war_profiles', 'war_active_profile_id']);
      const profile = data.war_profiles.find((item) => item.id === data.war_active_profile_id);
      return {
        nodeCount: nodes.length,
        linkCount: document.querySelectorAll('.canvas-link').length,
        steps: profile.steps.map((step) => ({ id: step.id, type: step.type, next: step.next || null, ui: step.ui }))
      };
    })()
  `);
  const [source, dest] = result.steps;
  const checks = [
    ['both nodes still exist', result.nodeCount === 2],
    ['graph connection persists visually', result.linkCount === 1],
    ['source position persists', near(source.ui, { x: 460, y: 240 })],
    ['destination position persists', near(dest.ui, { x: 80, y: 80 })],
    ['expected next relationship persists', source.next === dest.id]
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  trace.persistence = result;
  if (failed.length) throw new Error(`Persistence verification failed: ${failed.join(', ')}`);
  step(trace, 'Verified persistence', JSON.stringify(result));
}

try {
  await main();
} catch (error) {
  await finishFailureWithScreenshot({ trace, page: activePage, error });
}
