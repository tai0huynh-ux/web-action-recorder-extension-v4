import fs from 'node:fs';
import path from 'node:path';
import { validateSchemaValue } from '../../protocol/src/schemaValidator.js';
import { AgentError } from './errors.js';
import { assertSafeHttpUrl } from './browserController.js';
import { EmergencyStop } from './emergencyStop.js';
import { SemanticController } from './semanticController.js';
import { RawInputController } from './rawInputController.js';
import { requireString, validateButton, validateClickCount, validateKey, validateShortcut } from './inputSafety.js';

const SUPPORTED_TYPES = new Set([
  'browser.getState',
  'browser.start',
  'browser.stop',
  'browser.restart',
  'tab.list',
  'tab.open',
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
  'input.stopAll',
  'input.getState'
]);

const MUTATING_TYPES = new Set([
  'browser.start',
  'browser.stop',
  'browser.restart',
  'tab.open',
  'tab.activate',
  'tab.navigate',
  'tab.close',
  ...[...SUPPORTED_TYPES].filter((type) => type.startsWith('page.') || type.startsWith('input.') || type === 'browser.focusWindow' || type === 'browser.openInternalPage')
]);

export class ControlDispatcher {
  constructor({ supervisor, controller, deviceId, config = {}, log = () => {}, schemaPath = defaultSchemaPath(), now = () => Date.now(), cacheLimit = 500, cacheTtlMs = 10 * 60 * 1000, semanticController, rawInputController, emergencyStop }) {
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
  }

  async dispatch(envelope) {
    this.validateEnvelope(envelope);
    this.pruneCache();
    const cached = this.cache.get(envelope.idempotencyKey);
    if (cached) return cached.result;
    const result = await this.execute(envelope);
    if (MUTATING_TYPES.has(envelope.type)) {
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
      const data = await this.executePayload(envelope.type, envelope.payload);
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

  async executePayload(type, payload) {
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
      case 'tab.open':
        return { tab: await this.controller.openTab(payload.url) };
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
        return await this.rawInput.execute(type, payload);
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
}

export function validatePayload(type, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new AgentError('invalid_payload', 'Payload must be an object');
  if (type === 'tab.open') assertSafeHttpUrl(payload.url);
  if (type === 'tab.navigate') {
    requireString(payload.targetId, 'targetId');
    assertSafeHttpUrl(payload.url);
  }
  if (type === 'tab.activate' || type === 'tab.close') requireString(payload.targetId, 'targetId');
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
  if (type === 'browser.openInternalPage') requireString(payload.page, 'page', { max: 64 });
}

function defaultSchemaPath() {
  return path.resolve('platform/protocol/schemas/war-control-envelope.v1.schema.json');
}

export const supportedCommandTypes = [...SUPPORTED_TYPES];
