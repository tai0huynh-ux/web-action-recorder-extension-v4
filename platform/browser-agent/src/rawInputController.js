import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentError } from './errors.js';
import { CoordinateMapper } from './coordinateMapper.js';
import { limitsFromConfig, requireFiniteNumber, requireInteger, requireString, validateButton, validateClickCount, validateKey, validateShortcut } from './inputSafety.js';
import { X11InputClient } from './x11InputClient.js';

const execFileAsync = promisify(execFile);
const X11_BUTTONS = { left: '1', middle: '2', right: '3' };
const PLAYWRIGHT_MODIFIERS = { CTRL: 'Control', CONTROL: 'Control', SHIFT: 'Shift', ALT: 'Alt', META: 'Meta', ESCAPE: 'Escape', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight' };

export class InputQueue {
  constructor({ maxQueue = 50 } = {}) {
    this.maxQueue = maxQueue;
    this.queue = [];
    this.running = false;
    this.stopped = false;
  }

  enqueue(task) {
    if (this.queue.length >= this.maxQueue) throw new AgentError('input_queue_overflow', 'Input queue is full', 429);
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.drain();
    });
  }

  clear() {
    const dropped = this.queue.splice(0);
    for (const item of dropped) item.reject(new AgentError('command_aborted', 'Input command was cancelled', 499));
  }

  async runPriority(task) {
    this.clear();
    return task();
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift();
        try {
          item.resolve(await item.task());
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.running = false;
    }
  }

  getState() {
    return { queueLength: this.queue.length, running: this.running };
  }
}

export class RawInputController {
  constructor({ browserController, config = {}, emergencyStop, mapper, x11 = createX11Backend(), log = () => {} }) {
    this.browserController = browserController;
    this.limits = limitsFromConfig(config);
    this.mapper = mapper || new CoordinateMapper({
      viewportWidth: config.width,
      viewportHeight: config.height,
      screenWidth: config.width,
      screenHeight: config.height
    });
    this.queue = new InputQueue({ maxQueue: this.limits.inputMaxQueue });
    this.heldKeys = new Set();
    this.heldButtons = new Set();
    this.x11 = x11;
    this.log = log;
    emergencyStop?.onStop(() => this.stopAll());
  }

  async execute(type, payload) {
    if (type === 'input.stopAll') return this.stopAll();
    if (type === 'input.getState') return this.getState();
    return this.queue.enqueue(async () => this.executeNow(type, payload));
  }

  async executeNow(type, payload) {
    const space = validateSpace(payload.space);
    const backend = space === 'browser' || type === 'browser.focusWindow' ? 'x11' : 'cdp';
    const started = Date.now();
    let result;
    if (backend === 'cdp') result = await this.executeCdp(type, payload);
    else result = await this.executeX11(type, payload);
    return { backend, executed: true, duration: Date.now() - started, ...result };
  }

  async executeCdp(type, payload) {
    const page = await this.activePage();
    this.mapper.updateFromPage(page);
    switch (type) {
      case 'input.mouseMove': {
        const point = this.mapper.validatePoint(payload, 'viewport');
        await page.mouse.move(point.x, point.y, { steps: durationSteps(payload.durationMs, this.limits) });
        return { point };
      }
      case 'input.mouseDown': {
        const button = validateButton(payload.button);
        if (payload.x !== undefined || payload.y !== undefined) {
          const point = this.mapper.validatePoint(payload, 'viewport');
          await page.mouse.move(point.x, point.y);
        }
        await page.mouse.down({ button });
        this.heldButtons.add(button);
        return { button, ...(payload.x !== undefined || payload.y !== undefined ? { point: this.mapper.validatePoint(payload, 'viewport') } : {}) };
      }
      case 'input.mouseUp': {
        const button = validateButton(payload.button);
        if (payload.x !== undefined || payload.y !== undefined) {
          const point = this.mapper.validatePoint(payload, 'viewport');
          await page.mouse.move(point.x, point.y);
        }
        await page.mouse.up({ button });
        this.heldButtons.delete(button);
        return { button, ...(payload.x !== undefined || payload.y !== undefined ? { point: this.mapper.validatePoint(payload, 'viewport') } : {}) };
      }
      case 'input.click': {
        const point = this.mapper.validatePoint(payload, 'viewport');
        await page.mouse.click(point.x, point.y, { button: validateButton(payload.button), clickCount: validateClickCount(payload.clickCount) });
        return { point };
      }
      case 'input.wheel': {
        const point = this.mapper.validatePoint(payload, 'viewport');
        await page.mouse.move(point.x, point.y);
        await page.mouse.wheel(validateDelta(payload.deltaX ?? 0, this.limits), validateDelta(payload.deltaY ?? 0, this.limits));
        return { point };
      }
      case 'input.keyDown': {
        const key = validateKey(payload.key);
        await page.keyboard.down(key);
        this.heldKeys.add(key);
        return { key };
      }
      case 'input.keyUp': {
        const key = validateKey(payload.key);
        await page.keyboard.up(key);
        this.heldKeys.delete(key);
        return { key };
      }
      case 'input.insertText': {
        requireString(payload.text, 'text', { max: this.limits.inputMaxTextLength });
        await page.keyboard.insertText(payload.text);
        return { inserted: true };
      }
      case 'input.shortcut':
        return this.shortcutCdp(page, payload.keys);
      default:
        throw new AgentError('unsupported_command', 'Unsupported raw input command');
    }
  }

  async executeX11(type, payload) {
    switch (type) {
      case 'browser.focusWindow':
        await this.x11.focusChromium();
        return {};
      case 'input.mouseMove': {
        const point = this.mapper.validatePoint(payload, 'browser');
        await this.x11.mouseMove(point);
        return { point };
      }
      case 'input.click': {
        const point = this.mapper.validatePoint(payload, 'browser');
        await this.x11.clickAt(point, validateButton(payload.button), validateClickCount(payload.clickCount));
        return { point };
      }
      case 'input.mouseDown': {
        const button = validateButton(payload.button);
        if (payload.x !== undefined || payload.y !== undefined) await this.x11.mouseMove(this.mapper.validatePoint(payload, 'browser'));
        await this.x11.mouseDown(button);
        this.heldButtons.add(button);
        return { button };
      }
      case 'input.mouseUp': {
        const button = validateButton(payload.button);
        if (payload.x !== undefined || payload.y !== undefined) await this.x11.mouseMove(this.mapper.validatePoint(payload, 'browser'));
        await this.x11.mouseUp(button);
        this.heldButtons.delete(button);
        return { button };
      }
      case 'input.wheel': {
        const point = this.mapper.validatePoint(payload, 'browser');
        await this.x11.mouseMove(point);
        await this.x11.wheel(validateDelta(payload.deltaY ?? 0, this.limits));
        return { point };
      }
      case 'input.shortcut':
        await this.x11.shortcut(validateShortcut(payload.keys));
        return { shortcut: validateShortcut(payload.keys) };
      case 'input.keyDown': {
        const key = validateKey(payload.key);
        await this.x11.keyDown(key);
        this.heldKeys.add(key);
        return { key };
      }
      case 'input.keyUp': {
        const key = validateKey(payload.key);
        await this.x11.keyUp(key);
        this.heldKeys.delete(key);
        return { key };
      }
      case 'input.insertText':
        requireString(payload.text, 'text', { max: this.limits.inputMaxTextLength });
        await this.x11.typeText(payload.text);
        return { inserted: true };
      default:
        throw new AgentError('unsupported_command', 'Unsupported browser-space input command');
    }
  }

  async shortcutCdp(page, keys) {
    const shortcut = validateShortcut(keys);
    const parts = shortcut.split('+').map((key) => PLAYWRIGHT_MODIFIERS[key] || key);
    const main = parts.at(-1);
    const modifiers = parts.slice(0, -1);
    const pressed = [];
    let operationError;
    try {
      for (const key of modifiers) {
        await page.keyboard.down(key);
        pressed.push(key);
        this.heldKeys.add(key);
      }
      await page.keyboard.press(main);
    } catch (error) {
      operationError = error;
    }
    let releaseError;
    for (const key of pressed.reverse()) {
      try {
        await page.keyboard.up(key);
        this.heldKeys.delete(key);
      } catch (error) {
        releaseError ||= error;
      }
    }
    if (operationError) throw operationError;
    if (releaseError) throw releaseError;
    return { shortcut };
  }

  async activePage() {
    const targetId = this.browserController.activeTargetId || this.browserController.firstOpenTargetId();
    if (!targetId) throw new AgentError('tab_not_found', 'No active tab', 404);
    return this.browserController.findPage(targetId);
  }

  async stopAll() {
    return this.queue.runPriority(async () => {
      this.queue.clear();
      await this.x11.releaseAll?.({ priority: true }).catch(() => {});
      const page = await this.activePage().catch(() => undefined);
      for (const button of [...this.heldButtons]) {
        await page?.mouse?.up({ button }).catch(() => {});
        await this.x11.mouseUp(button).catch(() => {});
        this.heldButtons.delete(button);
      }
      for (const key of [...this.heldKeys]) {
        await page?.keyboard?.up(key).catch(() => {});
        await this.x11.keyUp(key).catch(() => {});
        this.heldKeys.delete(key);
      }
      return { stopped: true, heldKeys: 0, heldButtons: 0, queue: this.queue.getState() };
    });
  }

  getState() {
    return {
      heldKeys: [...this.heldKeys],
      heldButtons: [...this.heldButtons],
      queue: this.queue.getState()
    };
  }
}

export function createX11Backend(env = process.env) {
  if (env.WAR_X11_BACKEND === 'xdotool') return new X11Backend();
  return new X11InputClient();
}

export class X11Backend {
  constructor({ display = process.env.DISPLAY || ':99', timeoutMs = 2000 } = {}) {
    this.env = { ...process.env, DISPLAY: display };
    this.timeoutMs = timeoutMs;
  }

  async run(args) {
    await execFileAsync('xdotool', args, { env: this.env, timeout: this.timeoutMs });
  }

  async focusChromium() {
    await this.run(['search', '--onlyvisible', '--class', 'chromium', 'windowactivate']).catch(async () => {
      await this.run(['search', '--onlyvisible', '--class', 'chromium', 'windowfocus']);
    });
  }

  async mouseMove(point) {
    await this.run(['mousemove', String(Math.round(point.x)), String(Math.round(point.y))]);
  }

  async click(button, count = 1) {
    for (let i = 0; i < count; i += 1) await this.run(['click', X11_BUTTONS[button]]);
  }

  async clickAt(point, button, count = 1) {
    const args = ['mousemove', String(Math.round(point.x)), String(Math.round(point.y))];
    for (let i = 0; i < count; i += 1) args.push('click', X11_BUTTONS[button]);
    await this.run(args);
  }

  async mouseDown(button) {
    await this.run(['mousedown', X11_BUTTONS[button]]);
  }

  async mouseUp(button) {
    await this.run(['mouseup', X11_BUTTONS[button]]);
  }

  async keyDown(key) {
    await this.run(['keydown', key]);
  }

  async wheel(deltaY) {
    await this.run(['click', deltaY > 0 ? '5' : '4']);
  }

  async shortcut(shortcut) {
    await this.run(['key', shortcut.toLowerCase().replaceAll('ctrl', 'ctrl')]);
  }

  async keyUp(key) {
    await this.run(['keyup', key]);
  }

  async typeText(text) {
    await this.run(['type', '--delay', '0', text]);
  }

  async releaseAll() {}
}

function validateSpace(space = 'viewport') {
  if (space !== 'viewport' && space !== 'browser') throw new AgentError('invalid_payload', 'space must be viewport or browser');
  return space;
}

function validateDelta(value, limits) {
  requireFiniteNumber(value, 'delta');
  if (Math.abs(value) > limits.inputMaxScrollDelta) throw new AgentError('invalid_payload', 'wheel delta is invalid');
  return value;
}

function durationSteps(value = 0, limits) {
  const duration = requireInteger(value, 'durationMs', 0, limits.inputMaxDurationMs);
  return Math.max(1, Math.ceil(duration / 16));
}
