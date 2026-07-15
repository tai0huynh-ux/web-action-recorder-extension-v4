import {
  createTrace,
  detectExtensionOrBlock,
  evaluate,
  finish,
  finishFailureWithScreenshot,
  launchBrowser,
  openExtensionEditor,
  openTarget,
  parseBrowserArgs,
  selectBrowser,
  step,
  waitFor,
  waitForExpression
} from './browser-mv3-harness.js';
import { createServer } from 'node:http';

const trace = createTrace('switch-tab');
let run = null;
let source = null;
let target = null;
let control = null;
let editor = null;
let server = null;

async function startFixtureServer() {
  const fixture = createServer((request, response) => {
    const title = request.url.includes('target-site') ? 'target tab'
      : request.url.includes('control-site') ? 'control tab'
      : 'source tab';
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>${title}</title><main>${title}</main>`);
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  return fixture;
}

async function activateSourceTab() {
  return evaluate(editor, `
    chrome.tabs.query({}).then(async (tabs) => {
      const tab = tabs.find((item) => (item.url || '').includes('/source-site/source-page'));
      if (!tab) throw new Error('Source tab not found');
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tab.id, { active: true });
      return tab.url;
    })
  `);
}

try {
  const browser = selectBrowser(parseBrowserArgs());
  trace.browserName = browser.name;
  trace.browserExecutablePath = browser.path;
  run = await launchBrowser(browser.path);
  trace.browserVersion = run.version;
  const detected = await detectExtensionOrBlock({ trace, browser, run });
  if (!detected.ok) {
    finish(trace, 'Blocked', detected.reason, 2);
  } else {
    const extensionId = trace.extensionId;
    server = await startFixtureServer();
    const fixtureOrigin = `http://127.0.0.1:${server.address().port}`;
    source = await openTarget(run.port, `${fixtureOrigin}/source-site/source-page`);
    target = await openTarget(run.port, `${fixtureOrigin}/target-site/special-path`);
    control = await openTarget(run.port, `${fixtureOrigin}/control-site/other-path`);
    for (const page of [source, target, control]) {
      await page.send('Runtime.enable');
      await page.send('Page.enable');
    }
    editor = await openExtensionEditor(run.port, extensionId);

    const profile = {
      id: 'switch-tab-regression',
      name: 'Switch Tab Regression',
      enabled: true,
      steps: [
        { id: 'before', name: 'before-switch', type: 'log', message: 'before-switch', next: 'switch' },
        { id: 'switch', name: 'switch', type: 'switchTab', tabName: '*target-site/special-path*', next: 'after' },
        { id: 'after', name: 'after-switch', type: 'log', message: 'after-switch', delayAfterMs: 500 }
      ]
    };

    await evaluate(editor, `
      chrome.storage.local.set({
        war_profiles: ${JSON.stringify([profile])},
        war_active_profile_id: ${JSON.stringify(profile.id)},
        war_logs: []
      })
    `);
    const activatedSourceUrl = await activateSourceTab();
    step(trace, 'Activated source tab', activatedSourceUrl);
    const startResult = await evaluate(editor, `chrome.runtime.sendMessage({ type: 'RUN_PROFILE', profileId: ${JSON.stringify(profile.id)}, inputs: {} })`);
    if (!startResult?.ok) throw new Error(`RUN_PROFILE failed: ${startResult?.error || 'unknown error'}`);
    step(trace, 'Started switch-tab profile in source tab');
    await waitForExpression(target, `document.visibilityState === 'visible'`, 10000);
    let logs;
    try {
      logs = await waitFor(async () => {
        const current = await evaluate(editor, `chrome.storage.local.get('war_logs').then(data => data.war_logs || [])`);
        return current.filter((entry) => ['before-switch', 'after-switch'].includes(entry.message)).length >= 2 && current;
      }, 10000, 'before and after switch logs');
    } catch (error) {
      const current = await evaluate(editor, `chrome.storage.local.get('war_logs').then(data => data.war_logs || [])`);
      throw new Error(`${error.message}. Logs: ${JSON.stringify(current)}`);
    }

    const beforeLogs = logs.filter((entry) => entry.message === 'before-switch');
    const afterLogs = logs.filter((entry) => entry.message === 'after-switch');
    const connectionErrors = logs.filter((entry) => /Receiving end does not exist|Could not establish connection/i.test(entry.message || ''));
    if (beforeLogs.length !== 1) throw new Error(`Expected before-switch once, saw ${beforeLogs.length}`);
    if (afterLogs.length !== 1) throw new Error(`Expected after-switch once, saw ${afterLogs.length}`);
    if (!beforeLogs[0].url.includes('source-site')) throw new Error(`before-switch ran in unexpected tab: ${beforeLogs[0].url}`);
    if (!afterLogs[0].url.includes('target-site')) throw new Error(`after-switch ran in unexpected tab: ${afterLogs[0].url}`);
    if (connectionErrors.length) throw new Error(`Unexpected receiver connection error: ${connectionErrors[0].message}`);
    trace.sourceUrl = beforeLogs[0].url;
    trace.targetUrl = afterLogs[0].url;
    step(trace, 'Observed source URL', beforeLogs[0].url);
    step(trace, 'Observed target URL', afterLogs[0].url);

    const failingProfile = {
      ...profile,
      id: 'switch-tab-nonmatch',
      steps: profile.steps.map((item) => item.id === 'switch' ? { ...item, tabName: '*no-such-target-path*' } : item)
    };
    await evaluate(editor, `
      chrome.storage.local.set({
        war_profiles: ${JSON.stringify([failingProfile])},
        war_active_profile_id: ${JSON.stringify(failingProfile.id)},
        war_logs: []
      })
    `);
    await activateSourceTab();
    await evaluate(editor, `chrome.runtime.sendMessage({ type: 'RUN_PROFILE', profileId: ${JSON.stringify(failingProfile.id)}, inputs: {} })`);
    const failureLogs = await waitFor(async () => {
      const current = await evaluate(editor, `chrome.storage.local.get('war_logs').then(data => data.war_logs || [])`);
      return current.some((entry) => /No supported web tab matches Switch Tab pattern/.test(entry.message || '')) && current;
    }, 10000, 'controlled nonmatching switch-tab failure');
    if (failureLogs.some((entry) => entry.message === 'after-switch')) throw new Error('after-switch ran after nonmatching switch-tab pattern');
    step(trace, 'Verified nonmatching pattern failure', '*no-such-target-path*');

    finish(trace, 'Pass', `Switch tab handoff passed. Source: ${trace.sourceUrl}. Target: ${trace.targetUrl}.`, 0);
  }
} catch (error) {
  await finishFailureWithScreenshot({ trace, page: editor || target || source, error });
} finally {
  for (const page of [editor, control, target, source]) page?.close?.();
  await new Promise((resolve) => server?.close(resolve) || resolve());
  run?.close?.();
}
