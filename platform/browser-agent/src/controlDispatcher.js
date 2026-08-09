import fs from 'node:fs';
import path from 'node:path';
import { validateSchemaValue } from '../../protocol/src/schemaValidator.js';
import { AgentError } from './errors.js';
import { assertSafeHttpUrl } from './browserController.js';
import { EmergencyStop } from './emergencyStop.js';
import { SemanticController } from './semanticController.js';
import { RawInputController } from './rawInputController.js';
import { readX11Clipboard, startX11ClipboardPaste } from './clipboardVerifier.js';
import { requireString, validateButton, validateClickCount, validateKey, validateShortcut } from './inputSafety.js';

const SUPPORTED_TYPES = new Set([
  'browser.getState',
  'browser.start',
  'browser.stop',
  'browser.restart',
  'tab.list',
  'tab.new',
  'tab.open',
  'tab.back',
  'tab.forward',
  'tab.reload',
  'tab.home',
  'tab.activate',
  'tab.navigate',
  'tab.close',
  'page.click',
  'page.doubleClick',
  'page.hover',
  'page.focus',
  'page.fill',
  'page.type',
  'page.press',
  'page.selectOption',
  'page.check',
  'page.uncheck',
  'page.scroll',
  'page.waitFor',
  'page.getElementState',
  'page.listInteractiveElements',
  'page.uploadFile',
  'page.handleDialog',
  'page.screenshot',
  'input.mouseMove',
  'input.mouseDown',
  'input.mouseUp',
  'input.click',
  'input.wheel',
  'input.keyDown',
  'input.keyUp',
  'input.insertText',
  'input.shortcut',
  'browser.focusWindow',
  'browser.openInternalPage',
  'browser.getSandboxStatus',
  'clipboard.copySelection',
  'clipboard.pasteText',
  'input.stopAll',
  'input.getState'
]);

const MUTATING_TYPES = new Set([
  'browser.start',
  'browser.stop',
  'browser.restart',
  'tab.open',
  'tab.new',
  'tab.back',
  'tab.forward',
  'tab.reload',
  'tab.home',
  'tab.activate',
  'tab.navigate',
  'tab.close',
  ...[...SUPPORTED_TYPES].filter((type) => type.startsWith('page.') || type.startsWith('input.') || type === 'browser.focusWindow' || type === 'browser.openInternalPage' || type === 'clipboard.pasteText')
]);

export class ControlDispatcher {
  constructor({ supervisor, controller, deviceId, config = {}, log = () => {}, schemaPath = defaultSchemaPath(), now = () => Date.now(), cacheLimit = 500, cacheTtlMs = 10 * 60 * 1000, semanticController, rawInputController, clipboardReader = readX11Clipboard, clipboardWriter = startX11ClipboardPaste, emergencyStop }) {
    this.supervisor = supervisor;
    this.controller = controller;
    this.deviceId = deviceId;
    this.schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    this.now = now;
    this.cacheLimit = cacheLimit;
    this.cacheTtlMs = cacheTtlMs;
    this.cache = new Map();
    this.emergencyStop = emergencyStop || new EmergencyStop();
    this.semantic = semanticController || new SemanticController({ browserController: controller, config, emergencyStop: this.emergencyStop, log });
    this.rawInput = rawInputController || new RawInputController({ browserController: controller, config, emergencyStop: this.emergencyStop, log });
    this.clipboardReader = clipboardReader;
    this.clipboardWriter = clipboardWriter;
  }

  async dispatch(envelope) {
    this.validateEnvelope(envelope);
    this.pruneCache();
    const cacheable = envelope.type !== 'clipboard.copySelection';
    const cached = cacheable ? this.cache.get(envelope.idempotencyKey) : undefined;
    if (cached) return cached.result;
    const result = await this.execute(envelope);
    if (cacheable && MUTATING_TYPES.has(envelope.type)) {
      this.cache.set(envelope.idempotencyKey, { createdAt: this.now(), result });
      this.pruneCache();
    }
    return result;
  }

  validateEnvelope(envelope) {
    const schemaResult = validateSchemaValue(this.schema, envelope);
    if (!schemaResult.ok) throw new AgentError('invalid_envelope', 'Control envelope is invalid', 400, schemaResult.errors);
    if (envelope.protocol !== 'war-control.v1') throw new AgentError('invalid_protocol', 'Unsupported protocol');
    if (envelope.deviceId !== this.deviceId) throw new AgentError('wrong_device', 'Envelope deviceId does not match this node', 409);
    if (!SUPPORTED_TYPES.has(envelope.type)) throw new AgentError('unsupported_command', 'Unsupported command type');
    const timestamp = Date.parse(envelope.timestamp);
    if (!Number.isFinite(timestamp)) throw new AgentError('invalid_timestamp', 'Envelope timestamp is invalid');
    if (timestamp + envelope.deadlineMs < this.now()) throw new AgentError('deadline_exceeded', 'Command deadline has already passed', 408);
    validatePayload(envelope.type, envelope.payload);
  }

  async execute(envelope) {
    const startedAt = new Date(this.now()).toISOString();
    const startedMs = this.now();
    try {
      const data = await this.executePayload(envelope.type, envelope.payload, deadlineAt(envelope));
      const finishedAt = new Date(this.now()).toISOString();
      return {
        protocol: 'war-control.v1',
        messageId: envelope.messageId,
        type: envelope.type,
        status: 'succeeded',
        deviceId: this.deviceId,
        startedAt,
        finishedAt,
        durationMs: this.now() - startedMs,
        result: data
      };
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError('command_failed', error.message, 500);
    }
  }

  async executePayload(type, payload, commandDeadlineAt) {
    switch (type) {
      case 'browser.getState':
        return this.supervisor.getBrowserState();
      case 'browser.start':
        return this.supervisor.start();
      case 'browser.stop':
        return this.supervisor.stop();
      case 'browser.restart':
        return this.supervisor.restart();
      case 'tab.list':
        return { tabs: await this.controller.listTabs() };
      case 'tab.new':
        return { tab: await this.controller.openTab(payload.url) };
      case 'tab.open':
        return { tab: await this.controller.openTab(payload.url) };
      case 'tab.back':
        return { tab: await this.controller.backTab(payload.targetId) };
      case 'tab.forward':
        return { tab: await this.controller.forwardTab(payload.targetId) };
      case 'tab.reload':
        return { tab: await this.controller.reloadTab(payload.targetId) };
      case 'tab.home':
        return { tab: await this.controller.homeTab(payload.targetId) };
      case 'tab.activate':
        return { tab: await this.controller.activateTab(payload.targetId) };
      case 'tab.navigate':
        return { tab: await this.controller.navigateTab(payload.targetId, payload.url) };
      case 'tab.close':
        return await this.controller.closeTab(payload.targetId);
      case 'browser.openInternalPage':
        return { tab: await this.controller.openInternalPage(payload.page) };
      case 'browser.getSandboxStatus':
        return await this.controller.getSandboxStatus();
      case 'clipboard.copySelection': {
        const targetId = this.activeBrowserTargetId();
        const text = await this.runClipboardCompound(async (raw) => {
          await raw.execute('input.shortcut', { targetId, keys: 'CTRL+C', space: 'browser' });
          const remainingMs = commandDeadlineAt - this.now();
          if (remainingMs < 1) throw new AgentError('deadline_exceeded', 'Command deadline has already passed', 408);
          const copied = await this.clipboardReader({ maxBytes: 64 * 1024, timeoutMs: remainingMs });
          // Never return copied plaintext after the remote command is expired.
          if (commandDeadlineAt <= this.now()) throw new AgentError('deadline_exceeded', 'Command deadline has already passed', 408);
          return copied;
        }, commandDeadlineAt);
        return { copied: true, text, bytes: Buffer.byteLength(text, 'utf8') };
      }
      case 'clipboard.pasteText': {
        await this.runClipboardPaste(this.activeBrowserTargetId(), payload.text, commandDeadlineAt);
        return { pasted: true, bytes: Buffer.byteLength(payload.text, 'utf8') };
      }
      case 'browser.focusWindow':
      case 'input.mouseMove':
      case 'input.mouseDown':
      case 'input.mouseUp':
      case 'input.click':
      case 'input.wheel':
      case 'input.keyDown':
      case 'input.keyUp':
      case 'input.insertText':
      case 'input.shortcut':
      case 'input.stopAll':
      case 'input.getState':
        return await this.rawInput.execute(type, payload, { deadlineAt: commandDeadlineAt, now: this.now });
      default:
        if (type.startsWith('page.')) return await this.semantic.execute(type, payload, { deviceId: this.deviceId });
        throw new AgentError('unsupported_command', 'Unsupported command type');
    }
  }

  pruneCache() {
    const minTime = this.now() - this.cacheTtlMs;
    for (const [key, value] of this.cache.entries()) {
      if (value.createdAt < minTime) this.cache.delete(key);
    }
    while (this.cache.size > this.cacheLimit) {
      this.cache.delete(this.cache.keys().next().value);
    }
  }

  async runClipboardPaste(targetId, text, commandDeadlineAt) {
    await this.runClipboardCompound(async (raw) => {
      await this.assertClipboardWindow(targetId, commandDeadlineAt);
      const session = await this.clipboardWriter(text, { deadlineAt: commandDeadlineAt, now: this.now });
      if (!session || typeof session.waitForPaste !== 'function' || typeof session.abort !== 'function') {
        throw new AgentError('CLIPBOARD_WRITE_FAILED', 'X11 clipboard helper did not provide a one-shot session');
      }
      // Arm completion before the targeted CDP paste because xclip may finish
      // its post-SelectionRequest wait before Playwright returns control.
      const pasteCompletion = session.waitForPaste();
      try {
        // Clicking the Controller paste button can steal X11 focus while the
        // target lease remains cached. Reassert the browser window before Ctrl+V.
        await raw.execute('browser.focusWindow', { targetId });
        // Browser chrome (including the omnibox) is outside the page viewport.
        // Use the native X11 browser space so paste reaches either browser chrome or page focus.
        await raw.execute('input.shortcut', { targetId, keys: 'CTRL+V', space: 'browser' });
        await pasteCompletion;
        if (commandDeadlineAt <= this.now()) {
          throw new AgentError('deadline_exceeded', 'Command deadline has already passed', 408);
        }
      } catch (error) {
        await session.abort();
        await pasteCompletion.catch(() => {});
        throw error;
      }
    }, commandDeadlineAt);
  }

  async runClipboardCompound(task, commandDeadlineAt) {
    if (typeof this.rawInput?.executeCompound !== 'function') {
      throw new AgentError('raw_input_unavailable', 'Atomic native input queue is unavailable', 503);
    }
    if (typeof this.controller?.assertSingleWindowForRawInput !== 'function') {
      throw new AgentError('raw_input_unavailable', 'Single-window guard is unavailable', 503);
    }
    return this.rawInput.executeCompound(task, { deadlineAt: commandDeadlineAt, now: this.now });
  }

  async assertClipboardWindow(targetId, deadlineAt) {
    await this.controller.assertSingleWindowForRawInput(targetId);
    if (deadlineAt <= this.now()) {
      throw new AgentError('deadline_exceeded', 'Command deadline has already passed', 408);
    }
  }

  activeBrowserTargetId() {
    const targetId = this.controller.activeTargetId || this.controller.firstOpenTargetId?.();
    if (!targetId) throw new AgentError('tab_not_found', 'No active tab', 404);
    return targetId;
  }
}

export function validatePayload(type, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new AgentError('invalid_payload', 'Payload must be an object');
  if (type === 'tab.open') assertSafeHttpUrl(payload.url);
  if (type === 'tab.new' && payload.url !== undefined) assertSafeHttpUrl(payload.url);
  if (type === 'tab.navigate') {
    requireString(payload.targetId, 'targetId');
    assertSafeHttpUrl(payload.url);
  }
  if (type === 'tab.activate' || type === 'tab.close' || type === 'tab.back' || type === 'tab.forward' || type === 'tab.reload' || type === 'tab.home') requireString(payload.targetId, 'targetId');
  if (type.startsWith('page.') && type !== 'page.handleDialog' && type !== 'page.screenshot' && type !== 'page.listInteractiveElements') {
    requireString(payload.targetId, 'targetId');
    if (type !== 'page.scroll' || payload.target) {
      if (!payload.target) throw new AgentError('invalid_payload', 'target is required');
    }
  }
  if (type === 'page.handleDialog' || type === 'page.screenshot' || type === 'page.listInteractiveElements') requireString(payload.targetId, 'targetId');
  if (type === 'input.click') {
    validateButton(payload.button);
    validateClickCount(payload.clickCount);
  }
  if (type === 'input.keyDown' || type === 'input.keyUp') validateKey(payload.key);
  if (type === 'input.shortcut') validateShortcut(payload.keys);
  if (type === 'input.insertText') requireString(payload.text, 'text', { max: 65536 });
  if (type === 'browser.focusWindow' || (type.startsWith('input.') && !['input.stopAll', 'input.getState'].includes(type) && payload.space === 'browser')) {
    requireString(payload.targetId, 'targetId');
  }
  if (type === 'browser.openInternalPage') {
    requireString(payload.page, 'page', { max: 64 });
    if (!['settings', 'extensions', 'downloads', 'extensionSidePanel', 'extensionPage'].includes(payload.page)) throw new AgentError('invalid_payload', 'Internal page is not allowed');
  }
  if (type === 'clipboard.copySelection' && Object.keys(payload).length) throw new AgentError('invalid_payload', 'clipboard.copySelection does not accept a payload');
  if (type === 'clipboard.pasteText') {
    if (Object.keys(payload).length !== 1) throw new AgentError('invalid_payload', 'clipboard.pasteText payload is invalid');
    requireString(payload.text, 'text', { max: 64 * 1024 });
    if (Buffer.byteLength(payload.text, 'utf8') > 64 * 1024) throw new AgentError('invalid_payload', 'clipboard text exceeds 64 KiB');
  }
}

function defaultSchemaPath() {
  return path.resolve('platform/protocol/schemas/war-control-envelope.v1.schema.json');
}

function deadlineAt(envelope) {
  return Date.parse(envelope.timestamp) + envelope.deadlineMs;
}

export const supportedCommandTypes = [...SUPPORTED_TYPES];
