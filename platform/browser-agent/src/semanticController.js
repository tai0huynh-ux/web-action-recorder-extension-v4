import { AgentError } from './errors.js';
import { ArtifactRegistry } from './artifactRegistry.js';
import { ScreenshotController } from './screenshotController.js';
import { locatorFor, summarizeElement, validateTarget } from './elementTarget.js';
import { limitsFromConfig, requireInteger, requireObject, requireString, validateButton, validateClickCount, validateKey, validateTimeoutMs } from './inputSafety.js';

const WAIT_STATES = new Set(['attached', 'detached', 'visible', 'hidden', 'enabled', 'disabled']);

export class SemanticController {
  constructor({ browserController, config = {}, artifactRegistry, screenshotController, emergencyStop, log = () => {} }) {
    this.browserController = browserController;
    this.limits = limitsFromConfig(config);
    this.artifacts = artifactRegistry || new ArtifactRegistry({ uploadsDir: `${config.dataDir || '/data'}/uploads` });
    this.screenshots = screenshotController || new ScreenshotController({ artifactsDir: `${config.dataDir || '/data'}/artifacts/screenshots`, maxBytes: this.limits.screenshotMaxBytes });
    this.emergencyStop = emergencyStop;
    this.log = log;
  }

  async execute(type, payload, meta = {}) {
    const page = await this.browserController.findPage(payload.targetId);
    const signal = this.emergencyStop?.createSignal(payload.targetId);
    const startedUrl = page.url();
    const action = type.replace('page.', '');
    const result = await this[action](page, payload, signal);
    return {
      targetId: payload.targetId,
      action,
      navigationOccurred: startedUrl !== page.url(),
      ...result
    };
  }

  async click(page, payload, signal) {
    const locator = this.locator(page, payload);
    await locator.click({
      button: validateButton(payload.button),
      clickCount: validateClickCount(payload.clickCount),
      force: payload.force === true,
      timeout: validateTimeoutMs(payload.timeoutMs, this.limits),
      signal
    });
    return { element: await summarizeElement(locator) };
  }

  async doubleClick(page, payload, signal) {
    const locator = this.locator(page, payload);
    await locator.dblclick({ button: validateButton(payload.button), timeout: validateTimeoutMs(payload.timeoutMs, this.limits), signal });
    return { element: await summarizeElement(locator) };
  }

  async hover(page, payload, signal) {
    const locator = this.locator(page, payload);
    await locator.hover({ timeout: validateTimeoutMs(payload.timeoutMs, this.limits), signal });
    return { element: await summarizeElement(locator) };
  }

  async focus(page, payload, signal) {
    const locator = this.locator(page, payload);
    await locator.focus({ timeout: validateTimeoutMs(payload.timeoutMs, this.limits), signal });
    return { element: await summarizeElement(locator) };
  }

  async fill(page, payload, signal) {
    requireString(payload.value, 'value', { max: this.limits.inputMaxTextLength });
    const locator = this.locator(page, payload);
    await locator.fill(payload.value, { timeout: validateTimeoutMs(payload.timeoutMs, this.limits), signal });
    this.log('info', 'semantic', 'page.fill', { targetId: payload.targetId, value: '[REDACTED]' });
    return { element: await summarizeElement(locator) };
  }

  async type(page, payload, signal) {
    requireString(payload.text, 'text', { max: this.limits.inputMaxTextLength });
    const delay = payload.delayMs === undefined ? 0 : requireInteger(payload.delayMs, 'delayMs', 0, 1000);
    const locator = this.locator(page, payload);
    await locator.pressSequentially(payload.text, { delay, timeout: validateTimeoutMs(payload.timeoutMs, this.limits), signal });
    return { element: await summarizeElement(locator) };
  }

  async press(page, payload, signal) {
    const locator = this.locator(page, payload);
    await locator.press(validateKey(payload.key), { timeout: validateTimeoutMs(payload.timeoutMs, this.limits), signal });
    return { element: await summarizeElement(locator) };
  }

  async selectOption(page, payload, signal) {
    const locator = this.locator(page, payload);
    const options = validateSelectOptions(payload.options ?? payload.option);
    const selected = await locator.selectOption(options, { timeout: validateTimeoutMs(payload.timeoutMs, this.limits), signal });
    return { selected, element: await summarizeElement(locator) };
  }

  async check(page, payload, signal) {
    const locator = this.locator(page, payload);
    await locator.check({ timeout: validateTimeoutMs(payload.timeoutMs, this.limits), signal });
    return { element: await summarizeElement(locator) };
  }

  async uncheck(page, payload, signal) {
    const locator = this.locator(page, payload);
    await locator.uncheck({ timeout: validateTimeoutMs(payload.timeoutMs, this.limits), signal });
    return { element: await summarizeElement(locator) };
  }

  async scroll(page, payload) {
    const deltaX = clampDelta(payload.deltaX ?? 0, this.limits);
    const deltaY = clampDelta(payload.deltaY ?? 0, this.limits);
    if (payload.target) {
      const locator = this.locator(page, payload);
      await locator.evaluate((el, delta) => el.scrollBy(delta.x, delta.y), { x: deltaX, y: deltaY });
      return { scrolled: true, target: 'element' };
    }
    await page.mouse.wheel(deltaX, deltaY);
    return { scrolled: true, target: 'viewport' };
  }

  async waitFor(page, payload, signal) {
    const state = payload.state || 'visible';
    if (!WAIT_STATES.has(state)) throw new AgentError('invalid_payload', 'wait state is invalid');
    const locator = this.locator(page, payload);
    await locator.waitFor({ state: playwrightWaitState(state), timeout: validateTimeoutMs(payload.timeoutMs, this.limits), signal });
    if (state === 'enabled') await expectPredicate(locator, 'isEnabled', true, payload.timeoutMs, signal);
    if (state === 'disabled') await expectPredicate(locator, 'isEnabled', false, payload.timeoutMs, signal);
    return { state, element: await summarizeElement(locator) };
  }

  async getElementState(page, payload) {
    return { element: await summarizeElement(this.locator(page, payload)) };
  }

  async listInteractiveElements(page, payload) {
    const limit = requireInteger(payload.limit ?? 50, 'limit', 1, 200);
    const items = await page.locator('a,button,input,select,textarea,[role],[contenteditable="true"],[tabindex]').evaluateAll((elements, max) => {
      return elements.slice(0, max).map((el, index) => {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        return {
          elementId: `snapshot-${Date.now()}-${index}`,
          tagName: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || undefined,
          accessibleName: el.getAttribute('aria-label') || el.getAttribute('name') || undefined,
          text,
          boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          visible: rect.width > 0 && rect.height > 0,
          enabled: !el.disabled
        };
      });
    }, limit);
    return { elements: items };
  }

  async uploadFile(page, payload) {
    const locator = this.locator(page, payload);
    const files = Array.isArray(payload.files) ? payload.files : [];
    if (!files.length || files.length > 10) throw new AgentError('invalid_payload', 'files must contain 1..10 artifacts');
    const paths = [];
    for (const item of files) {
      requireObject(item, 'file');
      paths.push(await this.artifacts.resolveUpload(item.artifactId));
    }
    await locator.setInputFiles(paths, { timeout: validateTimeoutMs(payload.timeoutMs, this.limits) });
    return { uploaded: paths.length, element: await summarizeElement(locator) };
  }

  async handleDialog(page, payload) {
    const action = payload.action;
    if (action !== 'accept' && action !== 'dismiss') throw new AgentError('invalid_payload', 'dialog action is invalid');
    const timeoutMs = validateTimeoutMs(payload.timeoutMs ?? 3000, this.limits);
    const promptText = payload.promptText === undefined ? undefined : requireString(payload.promptText, 'promptText', { max: this.limits.inputMaxTextLength });
    const dialogPromise = page.waitForEvent('dialog', { timeout: timeoutMs });
    const dialog = await dialogPromise;
    if (action === 'accept') await dialog.accept(promptText);
    else await dialog.dismiss();
    return { handled: true, action, type: dialog.type?.() };
  }

  async screenshot(page, payload) {
    return { screenshot: await this.screenshots.capture(page, payload) };
  }

  locator(page, payload) {
    requireString(payload.targetId, 'targetId');
    validateTarget(payload.target);
    return locatorFor(page, payload.target);
  }
}

function validateSelectOptions(raw) {
  const list = Array.isArray(raw) ? raw : [raw];
  if (!list.length || list.length > 50) throw new AgentError('invalid_payload', 'select options are invalid');
  return list.map((item) => {
    requireObject(item, 'option');
    const output = {};
    if (item.value !== undefined) output.value = requireString(item.value, 'option.value', { max: 512 });
    if (item.label !== undefined) output.label = requireString(item.label, 'option.label', { max: 512 });
    if (item.index !== undefined) output.index = requireInteger(item.index, 'option.index', 0, 10000);
    if (!Object.keys(output).length) throw new AgentError('invalid_payload', 'select option requires value, label, or index');
    return output;
  });
}

function clampDelta(value, limits) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > limits.inputMaxScrollDelta) {
    throw new AgentError('invalid_payload', 'scroll delta is invalid');
  }
  return value;
}

function playwrightWaitState(state) {
  if (state === 'enabled' || state === 'disabled') return 'attached';
  return state;
}

async function expectPredicate(locator, method, expected, timeoutMs = 5000, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new AgentError('command_aborted', 'Command was aborted', 499);
    if (await locator[method]().catch(() => false) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new AgentError('semantic_timeout', 'Element state timed out', 408);
}
