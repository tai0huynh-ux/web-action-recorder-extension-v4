import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import nodeFs from 'node:fs';
import { ERROR_CODES } from '../../controller-core/src/errors.js';
import { ipv6Eui64SuffixFromMacAddress } from '../../controller-core/src/networkConfig.js';
import { mapFieldsToNamedInputs, mapRowsToDevices, parseInputText } from '../../input-parser/src/inputParser.js';
import { createWorkflowContentHash, createWorkflowRevisionFromExtensionProfile, extensionProfileFromWorkflowRevision } from '../../workflow-core/src/workflowMetadata.js';
import { applyLinksToSteps, collectOutgoingIds, validateGraph } from '../../../src/graph.js';
import { normalizeProfile, validateProfile } from '../../../src/shared.js';
import { MANAGED_CONTAINER_HOST_ID, toPublicRuntimeConfig } from './runtimeConfig.js';

export const DISPATCH_DEADLINE_SECONDS = Object.freeze({ min: 10, default: 300, max: 86400 });
// Serialized renderer-provided workflow inputs are capped before command dispatch.
export const MAX_DISPATCH_INPUT_BYTES = 64 * 1024;
const MAX_INPUT_DEPTH = 8;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_GROUPED_INPUT_BYTES = 64 * 1024;
const MAX_GROUPED_INPUT_ROWS = 200;
const GROUPED_INPUT_MODES = new Set(['text', 'table', 'cell']);
const REMOTE_CONTROL_COMMANDS = new Set([
  'browser.getState',
  'browser.focusWindow',
  'tab.list',
  'tab.open',
  'tab.activate',
  'tab.navigate',
  'tab.close',
  'input.mouseMove',
  'input.mouseDown',
  'input.mouseUp',
  'input.click',
  'input.wheel',
  'input.keyDown',
  'input.keyUp',
  'input.insertText',
  'input.shortcut',
  'input.stopAll',
  'input.getState',
]);
const MAX_REMOTE_TARGETS = 8;
const MAX_REMOTE_PAYLOAD_BYTES = 32768;
const REMOTE_AGENT_READY_TIMEOUT_MS = 60000;
const REMOTE_AGENT_READY_POLL_MS = 250;

export class ControllerApplicationService extends EventEmitter {
  constructor({ core, wssRuntime = null, wssTransport = null, containerAdapter = null, containerHostManager = null, config = null, version = '0.1.0', settingsStore = null, fs = nodeFs, now = () => new Date().toISOString(), id = (prefix) => `${prefix}-${crypto.randomUUID()}` }) { super(); this.core = core; this.wssRuntime = wssRuntime; this.wssTransport = wssTransport || wssRuntime?.adapter || wssRuntime; this.containerAdapter = containerAdapter; this.containerHostManager = containerHostManager; this.config = config; this.version = version; this.settingsStore = settingsStore; this.fs = fs; this.now = now; this.id = id; this.sequence = 0; this.remoteReadiness = new Map(); }
  result(data) { return Object.freeze({ ok: true, data: structuredClone(data) }); }
  invalidate(domain, identifiers = {}) { this.emit('invalidation', Object.freeze({ sequence: ++this.sequence, domain, ...identifiers })); }
  getBootstrapState() { return this.result({ applicationVersion: this.version, protocolVersion: 'v1', deviceCount: this.core.devices.listDevices().devices.length, sessionCount: this.core.sessions.listSessions().length, groupCount: this.core.groups.listGroups().groups.length, workflowCount: this.core.workflows.listMetadata().length, wss: this.getRuntimeStatus().data }); }
  getRuntimeStatus() {
    const publicConfig = this.config ? toPublicRuntimeConfig(this.config) : null;
    return this.result({
      enabled: Boolean(this.wssRuntime),
      status: this.wssRuntime ? 'running' : (publicConfig?.wss?.status || 'disabled'),
      bindHost: publicConfig?.wss?.host || '127.0.0.1',
      port: this.wssRuntime?.server?.address?.()?.port || publicConfig?.wss?.port || 0,
      storeStatus: publicConfig?.storeStatus || 'loaded',
      degraded: Boolean(publicConfig?.degraded),
      containers: publicConfig?.containers || { enabled: false, runtime: 'disabled', hostId: null, hostLabel: null },
      applicationVersion: this.version,
      protocolVersion: 'v1'
    });
  }
  async getDiagnostics() {
    const runtime = this.getRuntimeStatus().data;
    const publicConfig = this.config ? toPublicRuntimeConfig(this.config) : null;
    const checks = [];
    const addCheck = (check) => checks.push({ fixable: false, ...check });
    const wssConfigured = Boolean(publicConfig?.wss?.requested || runtime?.enabled);
    if (runtime?.enabled && runtime.status === 'running') {
      addCheck({ id: 'wss', area: 'wss', severity: 'ok', code: 'WSS_READY', message: 'Controller WSS is running' });
    } else if (wssConfigured) {
      for (const message of publicConfig?.errors || []) addCheck({ id: `wss-config-${checks.length}`, area: 'wss', severity: 'error', code: 'WSS_CONFIGURATION_ERROR', message, fixable: true, action: 'refresh-wss' });
      if (!publicConfig?.errors?.length) addCheck({ id: 'wss', area: 'wss', severity: 'error', code: 'WSS_NOT_RUNNING', message: 'Controller WSS is not running', fixable: true, action: 'refresh-wss' });
    } else {
      addCheck({ id: 'wss', area: 'wss', severity: 'warning', code: 'WSS_DISABLED', message: 'Controller WSS is disabled', fixable: false });
    }
    if (publicConfig?.containers?.enabled && !runtime?.enabled) {
      addCheck({ id: 'containers-wss', area: 'containers', severity: 'error', code: 'CONTAINERS_REQUIRE_WSS', message: 'Managed containers require a running Controller WSS endpoint', fixable: true, action: 'refresh-wss' });
    }

    let hostData = { status: 'disabled', hosts: [] };
    try { hostData = unwrapApplicationResult(await this.listContainerHosts()) || hostData; } catch (error) {
      addCheck({ id: 'linux-host-manager', area: 'linux', severity: 'error', code: error.code || 'LINUX_HOST_CHECK_FAILED', message: sanitizeDiagnosticMessage(error), fixable: false });
    }
    for (const host of hostData.hosts || []) {
      if (host.connected) addCheck({ id: `host:${host.id}`, area: 'linux', severity: 'ok', code: 'LINUX_HOST_READY', message: `${host.label || host.id} is ready`, targetId: `host:${host.id}` });
      else addCheck({ id: `host:${host.id}`, area: 'linux', severity: 'error', code: host.diagnostics?.error ? 'LINUX_HOST_NOT_READY' : 'LINUX_HOST_UNAVAILABLE', message: host.diagnostics?.error || `${host.label || host.id} is not ready`, targetId: `host:${host.id}`, fixable: true, action: 'repair-host' });
    }
    const paired = this.core.pairing.listPairedAgents();
    for (const agent of paired.filter((item) => !item.revokedAt)) {
      const session = this.core.sessions.getPublicSession(agent.deviceId);
      if (session?.status === 'online') addCheck({ id: `device:${agent.deviceId}`, area: 'agent', severity: 'ok', code: 'AGENT_ONLINE', message: `${agent.deviceId} is online`, targetId: `device:${agent.deviceId}` });
      else addCheck({ id: `device:${agent.deviceId}`, area: 'agent', severity: 'warning', code: 'AGENT_SESSION_OFFLINE', message: `${agent.deviceId} is not connected`, targetId: `device:${agent.deviceId}`, fixable: true, action: 'reconnect-agent' });
    }
    const containers = this.core.containers.listContainers().containers || [];
    for (const container of containers.filter((item) => item.status !== 'deleted')) {
      if (container.status === 'failed' || container.status === 'unavailable') addCheck({ id: `container:${container.id}`, area: 'container', severity: 'error', code: 'CONTAINER_FAILED', message: container.lastError || `${container.name || container.id} is not running`, targetId: `container:${container.id}`, fixable: true, action: 'reconnect-container' });
      if (container.deviceId) {
        try {
          const device = this.core.devices.getDevice(container.deviceId);
          if (device.capabilities?.remoteVideo !== true) addCheck({ id: `remote-agent:${container.id}`, area: 'agent', severity: 'warning', code: 'REMOTE_AGENT_UPDATE_REQUIRED', message: `${container.name || container.id} is using an Agent without remote video support`, targetId: `container:${container.id}`, fixable: true, action: 'reconnect-container' });
        } catch (error) {
          if (error?.code !== 'DEVICE_NOT_FOUND') throw error;
        }
      }
    }
    const summary = {
      total: checks.length,
      ok: checks.filter((item) => item.severity === 'ok').length,
      warning: checks.filter((item) => item.severity === 'warning').length,
      error: checks.filter((item) => item.severity === 'error').length,
      fixable: checks.filter((item) => item.fixable).length,
    };
    return this.result({ generatedAt: this.now(), summary, checks, runtime, hosts: hostData.hosts || [], containers: containers.map(sanitizeDiagnosticContainer), sessions: this.core.sessions.listSessions().map(sanitizeDiagnosticSession) });
  }
  async repairDiagnostics({ targetId } = {}) {
    const repairs = [];
    const failures = [];
    const attempt = async (id, action) => {
      try {
        const result = await action();
        if (id === 'wss' && result?.refreshed === false) throw codedError('WSS_TLS_RELOAD_UNAVAILABLE', result.reason || 'WSS TLS reload is unavailable');
        repairs.push({ targetId: id, ...(result || {}) });
      } catch (error) { failures.push({ targetId: id, code: error.code || 'DIAGNOSTIC_REPAIR_FAILED', message: sanitizeDiagnosticMessage(error) }); }
    };
    const target = String(targetId || '').trim();
    if (!target || target === 'wss') await attempt('wss', () => this.refreshWssTls());
    if (!target || target.startsWith('host:')) {
      const hosts = target.startsWith('host:')
        ? [{ id: target.slice(5) }]
        : (unwrapApplicationResult(await this.listContainerHosts())?.hosts || []).filter((host) => !host.connected);
      for (const host of hosts) await attempt(`host:${host.id}`, () => this.repairContainerHost({ hostId: host.id }));
    }
    if (target.startsWith('device:')) await attempt(target, () => this.reconnectAgent({ deviceId: target.slice(7) }));
    if (target.startsWith('container:')) await attempt(target, () => this.reconnectContainer({ containerId: target.slice(10) }));
    if (!target) {
      for (const agent of this.core.pairing.listPairedAgents().filter((item) => !item.revokedAt && this.core.sessions.getPublicSession(item.deviceId)?.status !== 'online')) {
        await attempt(`device:${agent.deviceId}`, () => this.reconnectAgent({ deviceId: agent.deviceId }));
      }
      for (const container of this.core.containers.listContainers().containers.filter((item) => ['failed', 'unavailable'].includes(item.status))) {
        await attempt(`container:${container.id}`, () => this.reconnectContainer({ containerId: container.id }));
      }
    }
    const diagnostics = await this.getDiagnostics();
    return this.result({ repairs, failures, diagnostics: diagnostics.data });
  }
  async refreshWssTls() {
    const server = this.wssRuntime?.server;
    const tls = this.config?.wss?.tls;
    if (!server || typeof server.setSecureContext !== 'function' || !tls?.certPath || !tls?.keyPath) {
      return { refreshed: false, reason: 'WSS TLS reload is unavailable in this runtime' };
    }
    const [cert, key] = await Promise.all([this.fs.promises.readFile(tls.certPath), this.fs.promises.readFile(tls.keyPath)]);
    server.setSecureContext({ cert, key });
    return { refreshed: true, reason: 'WSS TLS certificate and key reloaded' };
  }
  listPairings() { return this.result({ pending: this.core.pairing.listPendingPairings(), paired: this.core.pairing.listPairedAgents() }); }
  async requestPairing({ device, displayName, requestId }) { const data = await this.core.pairing.requestPairing({ device, displayName, requestId }); this.invalidate('pairings', { deviceId: device?.deviceId }); return this.result(data); }
  async confirmPairing({ requestId, code }) { const data = await this.core.pairing.confirmPairing(requestId, code); this.invalidate('pairings', { deviceId: data.deviceId }); this.invalidate('devices', { deviceId: data.deviceId }); return this.result(data); }
  async rejectPairing({ pairingId, reason }) { const data = await this.core.pairing.rejectPairing(pairingId, reason); this.invalidate('pairings'); return this.result(data); }
  async revokeAgent({ deviceId }) {
    const data = await this.core.pairing.revoke(deviceId);
    await this.core.sessions.closeDeviceSession(deviceId, 'revoked');
    this.invalidate('pairings', { deviceId });
    this.invalidate('devices', { deviceId });
    this.invalidate('sessions', { deviceId });
    return this.result(data);
  }
  async reconnectAgent({ deviceId }) {
    const device = this.core.devices.getDevice(deviceId);
    if (device.revoked) throw codedError('DEVICE_REVOKED', 'Revoked Agent cannot be reconnected');
    const session = this.core.sessions.getPublicSession(deviceId);
    if (session) await this.core.sessions.closeDeviceSession(deviceId, 'reconnect');
    this.invalidate('pairings', { deviceId });
    this.invalidate('devices', { deviceId });
    this.invalidate('sessions', { deviceId });
    return this.result({ deviceId, status: session ? 'reconnecting' : 'offline', requested: Boolean(session) });
  }
  listDevices() { return this.result(this.core.devices.listDevices()); }
  getDevice({ deviceId }) { return this.result(this.core.devices.getDevice(deviceId)); }
  async getSettings() { return this.result(await this.settingsStore.get()); }
  async updateSettings(payload) { const data = await this.settingsStore.update(payload); this.invalidate('settings'); return this.result(data); }
  listSessions() { return this.result({ sessions: this.core.sessions.listSessions() }); }
  async remoteCapture({ deviceId, quality = 45 } = {}) {
    if (!this.wssTransport?.requestRemoteControl) throw codedError('REMOTE_CONTROL_UNAVAILABLE', 'Remote control transport is unavailable');
    if (!Number.isInteger(quality) || quality < 20 || quality > 70) throw codedError('REMOTE_INVALID_QUALITY', 'Remote frame quality must be between 20 and 70');
    const readiness = await this.prepareRemoteTarget(deviceId);
    if (readiness.status === 'updating') return this.result({ deviceId, status: 'updating', code: 'REMOTE_AGENT_UPDATING', frame: null });
    const session = readiness.session;
    const response = await this.wssTransport.requestRemoteControl(deviceId, session.generation, {
      command: 'remote.capture',
      payload: { quality },
      requestId: this.id('remote-capture'),
      deadline: new Date(Date.parse(this.now()) + 10000).toISOString(),
    });
    if (response?.payload?.ok !== true) {
      throw codedError(response?.payload?.error?.code || 'REMOTE_CAPTURE_FAILED', response?.payload?.error?.message || 'Remote frame capture failed');
    }
    return this.result({ deviceId, frame: response.payload.frame || response.payload.result });
  }
  async remoteControl({ deviceIds, command, payload = {}, synchronized = false } = {}) {
    if (!REMOTE_CONTROL_COMMANDS.has(command)) throw codedError('REMOTE_COMMAND_NOT_ALLOWED', 'Remote command is not allowed');
    const ids = [...new Set(Array.isArray(deviceIds) ? deviceIds.filter((item) => typeof item === 'string' && item.trim()) : [])];
    if (!ids.length || ids.length > MAX_REMOTE_TARGETS) throw codedError('REMOTE_TARGET_LIMIT', `Select between 1 and ${MAX_REMOTE_TARGETS} online containers`);
    if (!isPlainObject(payload)) throw codedError('REMOTE_INVALID_PAYLOAD', 'Remote command payload must be an object');
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_REMOTE_PAYLOAD_BYTES) throw codedError('REMOTE_PAYLOAD_TOO_LARGE', 'Remote command payload is too large');
    if (!this.wssTransport?.requestRemoteControl) throw codedError('REMOTE_CONTROL_UNAVAILABLE', 'Remote control transport is unavailable');
    const syncAt = synchronized && ids.length > 1 ? new Date(Date.parse(this.now()) + 80).toISOString() : undefined;
    const results = await Promise.all(ids.map(async (deviceId) => {
      try {
        const readiness = await this.prepareRemoteTarget(deviceId);
        if (readiness.status === 'updating') return { deviceId, ok: false, error: { code: 'REMOTE_AGENT_UPDATING', message: 'Browser Agent is updating for remote control' } };
        const session = readiness.session;
        const response = await this.wssTransport.requestRemoteControl(deviceId, session.generation, {
          command,
          payload: structuredClone(payload),
          requestId: this.id('remote-control'),
          idempotencyKey: this.id('remote-command'),
          ...(syncAt ? { syncAt } : {}),
          deadline: new Date(Date.parse(this.now()) + 10000).toISOString(),
        });
        if (response?.payload?.ok !== true) return { deviceId, ok: false, error: response?.payload?.error || { code: 'REMOTE_CONTROL_FAILED', message: 'Remote command failed' } };
        return { deviceId, ok: true, result: response.payload.result };
      } catch (error) {
        return { deviceId, ok: false, error: { code: error.code || 'REMOTE_CONTROL_FAILED', message: String(error.message || 'Remote command failed').slice(0, 300) } };
      }
    }));
    return this.result({ command, synchronized: Boolean(syncAt), targets: results });
  }
  listContainers() { return this.result(this.core.containers.listContainers()); }
  listContainerTrash() {
    const containers = this.core.containers.listContainers().containers.filter((container) => container.status === 'deleted');
    const hosts = this.containerHostManager?.listTrashedHosts?.().hosts || [];
    return this.result({ containers, hosts });
  }
  async listContainerHosts() {
    if (this.containerHostManager) return this.result(await this.containerHostManager.listHosts());
    const publicConfig = this.config ? toPublicRuntimeConfig(this.config).containers : null;
    if (!publicConfig?.enabled || !this.containerAdapter?.probe) {
      return this.result({ status: 'disabled', hosts: [] });
    }
    const operation = await this.safeContainerOperation('probe', {});
    if (!operation.ok || operation.connected !== true) {
      return this.result({ status: 'unavailable', hosts: [] });
    }
    return this.result({
      status: 'connected',
      hosts: [{
        id: publicConfig.hostId || MANAGED_CONTAINER_HOST_ID,
        label: publicConfig.hostLabel || null,
        runtime: publicConfig.runtime,
        connected: true,
      }],
    });
  }
  async addContainerHost(payload) {
    if (!this.containerHostManager) throw codedError('CONTAINER_HOST_MANAGER_UNAVAILABLE', 'SSH host manager is unavailable');
    const data = await this.containerHostManager.addHost(payload);
    this.invalidate('containers');
    return this.result(data);
  }
  async updateContainerHost({ hostId, ...payload }) {
    if (!this.containerHostManager) throw codedError('CONTAINER_HOST_MANAGER_UNAVAILABLE', 'SSH host manager is unavailable');
    const data = await this.containerHostManager.updateHost(hostId, payload);
    this.invalidate('containers', { hostId });
    return this.result(data);
  }
  async checkContainerHost({ hostId }) {
    if (!this.containerHostManager) throw codedError('CONTAINER_HOST_MANAGER_UNAVAILABLE', 'SSH host manager is unavailable');
    return this.result(await this.containerHostManager.checkHost(hostId));
  }
  async reconnectContainerHost({ hostId }) {
    const data = await this.checkContainerHost({ hostId });
    this.invalidate('containers', { hostId });
    return data;
  }
  async repairContainerHost({ hostId }) {
    if (!this.containerHostManager) throw codedError('CONTAINER_HOST_MANAGER_UNAVAILABLE', 'SSH host manager is unavailable');
    const data = await this.containerHostManager.repairHost(hostId);
    this.invalidate('containers', { hostId });
    return this.result(data);
  }
  async trashContainerHost({ hostId }) {
    if (!this.containerHostManager) throw codedError('CONTAINER_HOST_MANAGER_UNAVAILABLE', 'SSH host manager is unavailable');
    const inUse = this.core.containers.listContainers().containers.filter((container) => container.host === hostId && container.status !== 'deleted');
    if (inUse.length) throw codedError('CONTAINER_HOST_IN_USE', 'Move containers on this Linux host to trash before removing the host', { containerIds: inUse.map((container) => container.id) });
    const data = await this.containerHostManager.trashHost(hostId);
    this.invalidate('containers', { hostId });
    return this.result(data);
  }
  async restoreContainerHost({ hostId }) {
    if (!this.containerHostManager) throw codedError('CONTAINER_HOST_MANAGER_UNAVAILABLE', 'SSH host manager is unavailable');
    const data = await this.containerHostManager.restoreHost(hostId);
    this.invalidate('containers', { hostId });
    return this.result(data);
  }
  async purgeContainerHost({ hostId }) {
    if (!this.containerHostManager) throw codedError('CONTAINER_HOST_MANAGER_UNAVAILABLE', 'SSH host manager is unavailable');
    const data = await this.containerHostManager.purgeHost(hostId);
    this.invalidate('containers', { hostId });
    return this.result(data);
  }
  async addContainer(payload) {
    const deviceId = payload.deviceId || `managed-${crypto.randomUUID()}`;
    const host = resolveManagedContainerHost(payload.host, this.config?.containers, this.containerHostManager);
    const hostAdapter = this.containerAdapterForHost(host);
    if (hostAdapter && (this.containerHostManager || this.config?.containers?.enabled)) {
      await this.ensureManagedHostReady(host);
      const probe = await this.safeContainerOperation('probe', {}, host);
      if (!probe.ok || probe.connected !== true) {
        throw codedError('CONTAINER_HOST_UNAVAILABLE', 'Selected managed Docker host is unavailable');
      }
    }
    const runtime = {
      ...(payload.runtime || {}),
      dockerName: payload.runtime?.dockerName || managedDockerName(payload.name),
    };
    const image = this.containerHostManager?.getHost(host)?.image || (this.config?.containers?.enabled ? this.config.containers.image : payload.image);
    const provisioning = await this.core.pairing.provisionManagedAgent({
      device: managedDeviceDescriptor({ deviceId, displayName: payload.name }),
      displayName: payload.name,
    });
    const container = await this.core.containers.createContainer({ ...payload, host, image, runtime, deviceId });
    const operation = await this.safeContainerOperation('create', { ...container, provisioning }, host);
    const next = operation.ok ? await this.core.containers.updateStatus(container.id, operation.status || 'running', { desiredState: 'running', runtime: operation.runtime }) : await this.core.containers.updateStatus(container.id, 'failed', { lastError: operation.error });
    if (!operation.ok) await this.core.pairing.revoke(deviceId).catch(() => {});
    this.invalidate('containers', { containerId: container.id });
    this.invalidate('pairings', { deviceId });
    this.invalidate('devices', { deviceId });
    return this.result({ container: next, operation });
  }
  async startContainer({ containerId }) { return this.containerLifecycle(containerId, 'start', 'running', 'running'); }
  async stopContainer({ containerId }) { return this.containerLifecycle(containerId, 'stop', 'stopped', 'stopped'); }
  async restartContainer({ containerId }) { return this.containerLifecycle(containerId, 'restart', 'running', 'running'); }
  async reconnectContainer({ containerId }) {
    const container = this.core.containers.getContainer(containerId);
    if (container.status === 'deleted' || container.status === 'deleting') throw codedError('CONTAINER_NOT_RECONNECTABLE', 'Deleted container cannot be reconnected');
    const start = ['created', 'stopped', 'failed', 'unavailable'].includes(container.status);
    return start ? this.startContainer({ containerId }) : this.restartContainer({ containerId });
  }
  async refreshContainer({ containerId }) {
    const container = this.core.containers.getContainer(containerId);
    const operation = await this.safeContainerOperation('status', container);
    const next = operation.ok ? await this.core.containers.updateStatus(containerId, operation.status || container.status, { resourceUsage: operation.resourceUsage, runtime: operation.runtime }) : await this.core.containers.updateStatus(containerId, 'failed', { lastError: operation.error });
    this.invalidate('containers', { containerId });
    return this.result({ container: next, operation });
  }
  async updateContainerNetwork({ containerId, ipv4Enabled = true, ipv6Enabled = false, ipv6Suffix }) {
    const container = this.core.containers.getContainer(containerId);
    const proposed = {
      ...container,
      runtime: {
        ...container.runtime,
        ipv4Enabled,
        ipv6Enabled,
        ipv6Suffix: ipv6Enabled ? ipv6Suffix : null,
        ipv6Prefix: null,
        ipv6Address: null,
        ipv6Network: null,
        ipv6PrefixChanged: false,
      },
    };
    const operation = await this.safeContainerOperation('updateNetwork', proposed);
    const next = operation.ok
      ? await this.core.containers.updateStatus(containerId, operation.status || container.status, { runtime: operation.runtime })
      : container;
    this.invalidate('containers', { containerId });
    return this.result({ container: next, operation });
  }
  async duplicateContainer({ containerId, name }) {
    const source = this.core.containers.getContainer(containerId);
    await this.ensureManagedHostReady(source.host);
    const deviceId = `managed-${crypto.randomUUID()}`;
    const provisioning = await this.core.pairing.provisionManagedAgent({
      device: managedDeviceDescriptor({ deviceId, displayName: name || `${source.name} copy` }),
      displayName: name || `${source.name} copy`,
    });
    const dockerName = `${source.runtime?.dockerName || source.id}-copy-${crypto.randomUUID().slice(0, 8)}`;
    const container = await this.core.containers.duplicateContainer(containerId, {
      name,
      deviceId,
      runtime: {
        ...source.runtime,
        dockerName,
        ipv6Suffix: source.runtime?.ipv6Enabled ? randomIpv6Suffix() : null,
        ipv6Prefix: null,
        ipv6Address: null,
        ipv6Network: null,
        ipv6PrefixChanged: false,
      },
    });
    const operation = await this.safeContainerOperation('create', { ...container, provisioning });
    const next = operation.ok ? await this.core.containers.updateStatus(container.id, operation.status || 'running', { desiredState: 'running', runtime: operation.runtime }) : await this.core.containers.updateStatus(container.id, 'failed', { lastError: operation.error });
    if (!operation.ok) await this.core.pairing.revoke(deviceId).catch(() => {});
    this.invalidate('containers', { containerId: container.id });
    this.invalidate('pairings', { deviceId });
    this.invalidate('devices', { deviceId });
    return this.result({ container: next, operation });
  }
  async deleteContainer({ containerId }) {
    const container = this.core.containers.getContainer(containerId);
    if (container.status === 'deleted') return this.result({ container, operation: { ok: true, status: 'deleted', alreadyTrashed: true } });
    const needsStop = !['created', 'stopped', 'failed'].includes(container.status);
    const operation = needsStop
      ? await this.safeContainerOperation('stop', container)
      : { ok: true, status: 'stopped', skipped: true };
    const next = operation.ok
      ? await this.core.containers.deleteContainer(containerId)
      : await this.core.containers.updateStatus(containerId, 'failed', { desiredState: 'stopped', lastError: operation.error });
    this.invalidate('containers', { containerId });
    return this.result({ container: next, operation });
  }
  async restoreContainer({ containerId }) {
    const container = await this.core.containers.restoreContainer(containerId);
    this.invalidate('containers', { containerId });
    return this.result({ container });
  }
  async purgeContainer({ containerId }) {
    const container = this.core.containers.getContainer(containerId);
    if (container.status !== 'deleted') throw codedError('CONTAINER_NOT_IN_TRASH', 'Container must be in trash before permanent deletion');
    if (container.deviceId) {
      await this.revokeAgent({ deviceId: container.deviceId }).catch((error) => {
        if (error?.code !== 'DEVICE_NOT_FOUND') throw error;
      });
    }
    const operation = isUnprovisionedContainer(container) && !this.containerAdapterForHost(container.host)?.delete
      ? { ok: true, status: 'deleted', localOnly: true }
      : await this.safeContainerOperation('delete', container);
    if (!operation.ok) {
      const failed = await this.core.containers.updateStatus(containerId, 'deleted', { desiredState: 'deleted', lastError: operation.error });
      this.invalidate('containers', { containerId });
      return this.result({ container: failed, operation, purged: null });
    }
    const purged = await this.core.containers.purgeContainer(containerId);
    this.invalidate('containers', { containerId });
    return this.result({ container: null, operation, purged });
  }
  listGroups() { return this.result(this.core.groups.listGroups()); }
  async createGroup(payload) { const data = await this.core.groups.createGroup(payload); this.invalidate('groups'); return this.result(data); }
  async updateGroup({ groupId, ...payload }) { const data = await this.core.groups.updateGroup(groupId, payload); this.invalidate('groups'); return this.result(data); }
  async deleteGroup({ groupId }) { const data = await this.core.groups.deleteGroup(groupId); this.invalidate('groups'); return this.result(data); }
  async addDeviceToGroup({ groupId, deviceId }) { const data = await this.core.groups.addDevice(groupId, deviceId); this.invalidate('groups', { deviceId }); return this.result(data); }
  async removeDeviceFromGroup({ groupId, deviceId }) { const data = await this.core.groups.removeDevice(groupId, deviceId); this.invalidate('groups', { deviceId }); return this.result(data); }
  listWorkflows() { return this.result({ workflows: this.core.workflows.listMetadata() }); }
  getWorkflowRevision({ workflowId, revision }) { return this.result(this.core.workflows.getRevision(workflowId, revision)); }
  async importWorkflowRevision({ workflow }) { const data = await this.core.workflows.putRevision(workflow); this.invalidate('workflows'); return this.result(data); }
  getWorkflowGraph(payload) { return this.result(this.buildWorkflowGraph(payload)); }
  previewWorkflowGraph(payload) { return this.result(this.buildWorkflowGraph(payload)); }
  async saveWorkflowGraph(payload) {
    const request = validateGraphRequest(payload);
    const current = this.core.workflows.getRevision(request.workflowId, request.revision);
    const profile = applyGraphOperations(extensionProfileFromWorkflowRevision(current), request.operations, this.id);
    validateProfile(profile);
    const validation = validateGraph(profile);
    if (!validation.ok) throw codedError('WORKFLOW_GRAPH_INVALID', 'Workflow graph is invalid', validation.errors);
    const nextRevision = createWorkflowRevisionFromExtensionProfile(profile, {
      sourceDeviceId: 'controller-graph',
      revision: current.revision + 1,
      now: this.now(),
    });
    const saved = await this.core.workflows.putRevision(nextRevision);
    this.invalidate('workflows');
    return this.result({ saved, graph: graphView(saved.revision) });
  }
  buildWorkflowGraph(payload) {
    const request = validateGraphRequest(payload);
    const workflow = this.core.workflows.getRevision(request.workflowId, request.revision);
    const profile = request.operations.length
      ? applyGraphOperations(extensionProfileFromWorkflowRevision(workflow), request.operations, this.id)
      : extensionProfileFromWorkflowRevision(workflow);
    return {
      workflow: { workflowId: workflow.workflowId, revision: workflow.revision, name: workflow.name, contentHash: workflow.contentHash },
      nodes: profile.steps,
      edges: graphEdges(profile.steps),
      validation: validateGraph(profile),
      executionPlan: executionPlan(profile),
    };
  }
  async previewOriginSync({ deviceId }) {
    const session = this.requireOnlineSession(deviceId);
    const response = await this.wssTransport.requestOriginInventory(deviceId, session.generation, { entityTypes: ['workflows'] });
    const inventory = sanitizeOriginInventory(response.payload || {});
    const preview = this.buildOriginPreview(deviceId, inventory);
    return this.result(preview);
  }
  async pullOriginSync({ deviceId, conflictPolicy = 'preserveBoth' }) {
    if (!['preserveBoth', 'skip'].includes(conflictPolicy)) throw codedError('INVALID_ORIGIN_SYNC_POLICY', 'Unsupported origin sync policy');
    const session = this.requireOnlineSession(deviceId);
    const preview = this.buildOriginPreview(deviceId, sanitizeOriginInventory((await this.wssTransport.requestOriginInventory(deviceId, session.generation, { entityTypes: ['workflows'] })).payload || {}));
    const imported = [];
    const skipped = [];
    for (const item of preview.workflows) {
      if (item.action === 'skipIdentical' || (item.conflict && conflictPolicy === 'skip')) {
        skipped.push({ workflowId: item.workflowId, revision: item.revision, reason: item.action });
        continue;
      }
      const response = await this.wssTransport.requestOriginWorkflow(deviceId, session.generation, { workflowId: item.workflowId, revision: item.revision });
      if (response.payload?.error) throw codedError(response.payload.error.code || 'ORIGIN_WORKFLOW_GET_FAILED', response.payload.error.message || 'Origin workflow pull failed');
      const workflow = sanitizeOriginWorkflow(response.payload?.workflow);
      const result = await this.core.workflows.putRevision(workflow);
      imported.push({ workflowId: result.revision.workflowId, revision: result.revision.revision, created: result.created, contentHash: result.revision.contentHash });
    }
    const syncResult = await this.persistOriginSyncResult({ deviceId, conflictPolicy, imported, skipped, preview });
    this.invalidate('workflows');
    this.invalidate('originSync', { deviceId });
    return this.result(syncResult);
  }
  listJobs(payload) { return this.result({ jobs: this.core.jobs.listCommands(payload) }); }
  getJob({ jobId }) { return this.result(this.core.jobs.getCommand(jobId)); }
  listJobEvents(payload) { return this.result({ events: this.core.events.listRecent(payload) }); }
  previewGroupedInput(payload) { return this.result(this.buildGroupedInputPlan(payload)); }
  async dispatchGroupedInput(payload) {
    const plan = this.buildGroupedInputPlan(payload);
    const dispatched = [];
    for (const assignment of plan.assignments) {
      const result = await this.dispatchWorkflow({
        deviceId: assignment.deviceId,
        workflowId: plan.workflow.workflowId,
        revision: plan.workflow.revision,
        inputs: assignment.inputs,
        deadlineSeconds: plan.deadlineSeconds,
      });
      dispatched.push({ deviceId: assignment.deviceId, job: result.data.job, transport: result.data.transport });
    }
    return this.result({ ...plan, dispatched });
  }
  async dispatchWorkflow(payload) {
    const request = validateDispatchRequest(payload);
    const device = this.core.devices.getDevice(request.deviceId);
    if (device.revoked) throw codedError(ERROR_CODES.DEVICE_REVOKED, 'Device is revoked');
    const session = this.core.sessions.getPublicSession(request.deviceId);
    if (!session) throw codedError('SESSION_OFFLINE', 'Active session not found');
    const workflow = this.core.workflows.getRevision(request.workflowId, request.revision);
    const inputs = validateWorkflowInputs(workflow, request.inputs || {});
    const deadline = this.createDeadline(request.deadlineSeconds);
    const idempotencyKey = this.id('dispatch');
    const { command, dispatch } = await this.core.sessions.dispatch({
      deviceId: request.deviceId,
      generation: session.generation,
      workflowId: workflow.workflowId,
      workflowRevision: workflow.revision,
      workflowContentHash: workflow.contentHash,
      inputs,
      deadline,
      idempotencyKey
    });
    const transport = this.deliverDispatch(request.deviceId, session.generation, dispatch);
    this.invalidate('jobs', { jobId: command.id });
    return this.result({ job: sanitizeJob(command), transport });
  }

  async cancelJob({ jobId }) {
    const current = this.core.jobs.getCommand(jobId);
    const session = this.core.sessions.getPublicSession(current.deviceId);
    const job = await this.core.jobs.cancelCommand(jobId);
    const transport = this.deliverCancel(job, session);
    this.invalidate('jobs', { jobId });
    return this.result({ job: sanitizeJob(job), transport });
  }

  requireOnlineSession(deviceId) {
    const session = this.core.sessions.getPublicSession(deviceId);
    if (!session || session.status !== 'online') throw codedError('SESSION_OFFLINE', 'Origin device is not connected');
    if (!this.wssTransport?.requestOriginInventory || !this.wssTransport?.requestOriginWorkflow) throw codedError('ORIGIN_SYNC_UNAVAILABLE', 'Origin sync transport is unavailable');
    return session;
  }

  requireRemoteSession(deviceId) {
    const session = this.core.sessions.getPublicSession(deviceId);
    if (!session || session.status !== 'online') throw codedError('SESSION_OFFLINE', 'Remote target is offline');
    return session;
  }

  buildOriginPreview(deviceId, inventory) {
    const local = this.core.workflows.listMetadata();
    const workflows = inventory.workflows.map((item) => {
      const sameHash = local.find((entry) => entry.workflowId === item.workflowId && entry.contentHash === item.contentHash);
      const sameId = local.find((entry) => entry.workflowId === item.workflowId);
      const conflict = Boolean(!sameHash && sameId);
      return {
        workflowId: item.workflowId,
        revision: item.revision,
        name: item.name,
        contentHash: item.contentHash,
        updatedAt: item.updatedAt,
        conflict,
        action: sameHash ? 'skipIdentical' : conflict ? 'preserveBoth' : 'importNew',
      };
    });
    return { deviceId, counts: { workflows: workflows.length }, workflows };
  }

  async persistOriginSyncResult(result) {
    const item = {
      id: this.id('origin-sync'),
      deviceId: result.deviceId,
      conflictPolicy: result.conflictPolicy,
      imported: result.imported,
      skipped: result.skipped,
      previewCounts: result.preview.counts,
      completedAt: this.now(),
    };
    return this.core.store.update((state) => {
      state.originSyncResults ||= [];
      state.originSyncResults.push(item);
      if (state.originSyncResults.length > 100) state.originSyncResults = state.originSyncResults.slice(-100);
      this.core.audit.append(state, 'origin.sync.completed', { syncId: item.id, deviceId: item.deviceId, imported: item.imported.length, skipped: item.skipped.length });
      return structuredClone(item);
    });
  }

  createDeadline(deadlineSeconds) {
    const seconds = deadlineSeconds ?? DISPATCH_DEADLINE_SECONDS.default;
    if (!Number.isInteger(seconds) || seconds < DISPATCH_DEADLINE_SECONDS.min || seconds > DISPATCH_DEADLINE_SECONDS.max) {
      throw codedError('DEADLINE_SECONDS_OUT_OF_RANGE', 'Deadline seconds is outside the supported range');
    }
    return new Date(Date.parse(this.now()) + seconds * 1000).toISOString();
  }

  deliverDispatch(deviceId, generation, dispatch) {
    if (!this.wssTransport?.sendDispatch) return { delivered: false, warningCode: 'SESSION_OFFLINE' };
    try {
      this.wssTransport.sendDispatch(deviceId, generation, dispatch);
      return { delivered: true };
    } catch (error) {
      return { delivered: false, warningCode: typeof error?.code === 'string' ? error.code : 'WSS_SEND_FAILED' };
    }
  }

  deliverCancel(job, session) {
    if (!session || !this.wssTransport?.sendCancel) return { delivered: false, acknowledged: false, warningCode: 'SESSION_OFFLINE' };
    try {
      this.wssTransport.sendCancel(job.deviceId, session.generation, {
        jobId: job.id,
        deadline: this.createDeadline(DISPATCH_DEADLINE_SECONDS.default),
        idempotencyKey: this.id('cancel')
      });
      return { delivered: true, acknowledged: false };
    } catch (error) {
      return { delivered: false, acknowledged: false, warningCode: typeof error?.code === 'string' ? error.code : 'WSS_SEND_FAILED' };
    }
  }

  buildGroupedInputPlan(payload) {
    const request = validateGroupedInputRequest(payload);
    const workflow = this.core.workflows.getRevision(request.workflowId, request.revision);
    const definitions = Array.isArray(workflow.requiredInputs) ? workflow.requiredInputs : [];
    const devices = request.deviceIds.map((deviceId) => {
      const device = this.core.devices.getDevice(deviceId);
      if (device.revoked) throw codedError(ERROR_CODES.DEVICE_REVOKED, 'Device is revoked');
      return { id: device.id || device.deviceId, name: device.name || device.displayName || deviceId };
    });
    const parsed = parseInputText(request.text);
    if (parsed.rows.length > MAX_GROUPED_INPUT_ROWS) throw codedError('GROUPED_INPUT_TOO_MANY_ROWS', 'Grouped input has too many rows');
    const mappedRows = mapRowsToDevices({
      rows: parsed.rows,
      devices,
      expectedFieldCount: expectedFieldCountFor(definitions),
      broadcastSingleRow: request.broadcastSingleRow,
    });
    const assignments = mappedRows.map((row) => {
      const inputs = coerceGroupedInputs(mapFieldsToNamedInputs(row.fields, definitions), definitions);
      validateWorkflowInputs(workflow, inputs);
      return {
        deviceId: row.deviceId,
        sourceRowIndex: row.sourceRowIndex,
        inputs,
        preview: redactGroupedPreview(inputs, definitions),
      };
    });
    return {
      mode: request.mode,
      workflow: { workflowId: workflow.workflowId, revision: workflow.revision, name: workflow.name, requiredInputs: definitions },
      counts: { devices: devices.length, rows: parsed.rows.length, assignments: assignments.length },
      deadlineSeconds: request.deadlineSeconds,
      assignments,
    };
  }

  async containerLifecycle(containerId, action, status, desiredState) {
    const current = this.core.containers.getContainer(containerId);
    if (['start', 'restart'].includes(action)) await this.ensureManagedHostReady(current.host);
    if (current.deviceId) this.remoteReadiness.delete(current.deviceId);
    const progressStatus = action === 'start' ? 'starting' : action === 'stop' ? 'stopping' : 'restarting';
    const container = await this.core.containers.updateStatus(containerId, progressStatus, { desiredState });
    const operation = await this.safeContainerOperation(action, container);
    const next = operation.ok ? await this.core.containers.updateStatus(containerId, status, { desiredState, resourceUsage: operation.resourceUsage, runtime: operation.runtime }) : await this.core.containers.updateStatus(containerId, 'failed', { desiredState, lastError: operation.error });
    this.invalidate('containers', { containerId });
    return this.result({ container: next, operation });
  }

  containerAdapterForHost(hostId) {
    return this.containerHostManager?.getAdapter(hostId) || this.containerAdapter;
  }

  async ensureManagedHostReady(hostId) {
    if (!this.containerHostManager || !hostId || typeof this.containerHostManager.ensureReady !== 'function') return null;
    const checked = await this.containerHostManager.ensureReady(hostId);
    if (checked?.connected !== true) throw codedError('CONTAINER_HOST_UNAVAILABLE', checked?.diagnostics?.error || 'Selected managed Docker host is unavailable');
    return checked;
  }

  async prepareRemoteTarget(deviceId) {
    const session = this.requireRemoteSession(deviceId);
    const device = this.core.devices.getDevice(deviceId);
    if (device.capabilities?.remoteVideo === true) return { status: 'ready', session };

    const container = this.core.containers.listContainers().containers.find((item) => item.deviceId === deviceId && !['deleted', 'deleting'].includes(item.status));
    if (!container || !container.host || !this.containerHostManager) throw codedError('REMOTE_AGENT_UPDATE_REQUIRED', 'This Agent does not support remote video; reconnect it from a managed container host');

    const existing = this.remoteReadiness.get(deviceId);
    if (existing?.state === 'updating') return { status: 'updating' };
    if (existing?.state === 'failed') throw existing.error;

    const job = { state: 'updating', error: null, promise: null };
    this.remoteReadiness.set(deviceId, job);
    job.promise = this.upgradeManagedRemoteAgent(container, session.generation)
      .then(() => { this.remoteReadiness.delete(deviceId); })
      .catch((error) => {
        const failure = error?.code ? error : codedError('REMOTE_AGENT_UPDATE_FAILED', sanitizeContainerError(error));
        job.state = 'failed';
        job.error = failure;
        throw failure;
      });
    job.promise.catch(() => {});
    return { status: 'updating' };
  }

  async upgradeManagedRemoteAgent(container, previousGeneration) {
    await this.ensureManagedHostReady(container.host);
    const operation = await this.safeContainerOperation('restart', container, container.host);
    if (!operation.ok) throw codedError('REMOTE_AGENT_UPDATE_FAILED', operation.error || 'Managed Browser Agent restart failed');
    await this.core.containers.updateStatus(container.id, 'running', { desiredState: 'running', runtime: operation.runtime, lastError: null });
    this.invalidate('containers', { containerId: container.id });
    await this.waitForRemoteVideo(container.deviceId, previousGeneration);
  }

  async waitForRemoteVideo(deviceId, previousGeneration) {
    const deadline = Date.now() + REMOTE_AGENT_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const session = this.core.sessions.getPublicSession(deviceId);
      let device;
      try { device = this.core.devices.getDevice(deviceId); } catch { device = null; }
      if (session?.status === 'online' && session.generation > previousGeneration && device?.capabilities?.remoteVideo === true) return session;
      await new Promise((resolve) => setTimeout(resolve, REMOTE_AGENT_READY_POLL_MS));
    }
    throw codedError('REMOTE_AGENT_UPDATE_TIMEOUT', 'Browser Agent restarted but did not report remote video capability in time');
  }

  async safeContainerOperation(action, container, hostId = container?.host) {
    const adapter = this.containerAdapterForHost(hostId);
    if (!adapter?.[action]) return { ok: false, error: 'CONTAINER_ADAPTER_UNAVAILABLE' };
    try {
      const result = await adapter[action](structuredClone(container));
      return { ok: true, ...(result || {}) };
    } catch (error) {
      return { ok: false, error: sanitizeContainerError(error) };
    }
  }
}

function validateDispatchRequest(payload) {
  if (!isPlainObject(payload)) throw codedError('INVALID_DISPATCH_PAYLOAD', 'Dispatch payload must be an object');
  for (const key of Reflect.ownKeys(payload)) {
    if (typeof key !== 'string' || !['deviceId', 'workflowId', 'revision', 'inputs', 'deadlineSeconds'].includes(key)) {
      throw codedError('INVALID_DISPATCH_PAYLOAD', 'Dispatch payload contains an unknown property');
    }
  }
  if (typeof payload.deviceId !== 'string' || payload.deviceId.trim() === '') throw codedError('INVALID_DISPATCH_PAYLOAD', 'Invalid deviceId');
  if (typeof payload.workflowId !== 'string' || payload.workflowId.trim() === '') throw codedError('INVALID_DISPATCH_PAYLOAD', 'Invalid workflowId');
  if (!Number.isInteger(payload.revision) || payload.revision < 1) throw codedError('INVALID_DISPATCH_PAYLOAD', 'Invalid revision');
  if (payload.inputs !== undefined && !isPlainObject(payload.inputs)) throw codedError('INVALID_WORKFLOW_INPUTS', 'Workflow inputs must be an object');
  return {
    deviceId: payload.deviceId,
    workflowId: payload.workflowId,
    revision: payload.revision,
    inputs: payload.inputs === undefined ? {} : structuredClone(payload.inputs),
    deadlineSeconds: payload.deadlineSeconds
  };
}

function validateGroupedInputRequest(payload) {
  if (!isPlainObject(payload)) throw codedError('INVALID_GROUPED_INPUT_PAYLOAD', 'Grouped input payload must be an object');
  for (const key of Reflect.ownKeys(payload)) {
    if (typeof key !== 'string' || !['workflowId', 'revision', 'deviceIds', 'text', 'mode', 'broadcastSingleRow', 'deadlineSeconds'].includes(key)) {
      throw codedError('INVALID_GROUPED_INPUT_PAYLOAD', 'Grouped input payload contains an unknown property');
    }
  }
  if (typeof payload.workflowId !== 'string' || payload.workflowId.trim() === '') throw codedError('INVALID_GROUPED_INPUT_PAYLOAD', 'Invalid workflowId');
  if (!Number.isInteger(payload.revision) || payload.revision < 1) throw codedError('INVALID_GROUPED_INPUT_PAYLOAD', 'Invalid revision');
  if (!Array.isArray(payload.deviceIds) || payload.deviceIds.length === 0 || payload.deviceIds.length > 200 || payload.deviceIds.some((id) => typeof id !== 'string' || !id.trim())) {
    throw codedError('INVALID_GROUPED_INPUT_PAYLOAD', 'At least one bounded deviceId is required');
  }
  if (new Set(payload.deviceIds).size !== payload.deviceIds.length) throw codedError('DUPLICATE_GROUPED_DEVICE', 'Grouped input deviceIds must be unique');
  if (typeof payload.text !== 'string') throw codedError('INVALID_GROUPED_INPUT_PAYLOAD', 'Grouped input text is required');
  if (Buffer.byteLength(payload.text, 'utf8') > MAX_GROUPED_INPUT_BYTES) throw codedError('GROUPED_INPUT_TOO_LARGE', 'Grouped input exceeds maximum size');
  const mode = payload.mode || 'text';
  if (!GROUPED_INPUT_MODES.has(mode)) throw codedError('INVALID_GROUPED_INPUT_MODE', 'Unsupported grouped input mode');
  return {
    workflowId: payload.workflowId,
    revision: payload.revision,
    deviceIds: [...payload.deviceIds],
    text: payload.text,
    mode,
    broadcastSingleRow: payload.broadcastSingleRow !== false,
    deadlineSeconds: payload.deadlineSeconds,
  };
}

function validateGraphRequest(payload) {
  if (!isPlainObject(payload)) throw codedError('INVALID_GRAPH_PAYLOAD', 'Graph payload must be an object');
  for (const key of Reflect.ownKeys(payload)) {
    if (typeof key !== 'string' || !['workflowId', 'revision', 'operations'].includes(key)) throw codedError('INVALID_GRAPH_PAYLOAD', 'Graph payload contains an unknown property');
  }
  if (typeof payload.workflowId !== 'string' || payload.workflowId.trim() === '') throw codedError('INVALID_GRAPH_PAYLOAD', 'Invalid workflowId');
  if (!Number.isInteger(payload.revision) || payload.revision < 1) throw codedError('INVALID_GRAPH_PAYLOAD', 'Invalid revision');
  if (payload.operations !== undefined && (!Array.isArray(payload.operations) || payload.operations.length > 100)) throw codedError('INVALID_GRAPH_PAYLOAD', 'Invalid graph operations');
  return { workflowId: payload.workflowId, revision: payload.revision, operations: structuredClone(payload.operations || []) };
}

function graphView(revision) {
  const profile = extensionProfileFromWorkflowRevision(revision);
  const validation = validateGraph(profile);
  return {
    workflowId: revision.workflowId,
    revision: revision.revision,
    contentHash: revision.contentHash,
    nodes: profile.steps,
    edges: graphEdges(profile.steps),
    validation,
    executionPlan: executionPlan(profile),
  };
}

function graphEdges(steps) {
  return steps.flatMap((step) => collectOutgoingIds(step).map((to) => ({ from: step.id, to })));
}

function executionPlan(profile) {
  const roots = validateGraph(profile).roots || [];
  const byId = new Map((profile.steps || []).map((step) => [step.id, step]));
  const seen = new Set();
  const ordered = [];
  const visit = (id) => {
    if (seen.has(id) || !byId.has(id)) return;
    seen.add(id);
    ordered.push(id);
    for (const next of collectOutgoingIds(byId.get(id))) visit(next);
  };
  roots.forEach(visit);
  return ordered;
}

function applyGraphOperations(profile, operations, idFactory) {
  const next = normalizeProfile(profile);
  for (const operation of operations) applyGraphOperation(next, operation, idFactory);
  return next;
}

function applyGraphOperation(profile, operation, idFactory) {
  if (!isPlainObject(operation) || typeof operation.type !== 'string') throw codedError('INVALID_GRAPH_OPERATION', 'Invalid graph operation');
  if (operation.type === 'addNode') {
    profile.steps.push(sanitizeGraphNode({ id: idFactory('step'), ...(operation.node || {}) }));
  } else if (operation.type === 'updateNode') {
    const index = profile.steps.findIndex((step) => step.id === operation.nodeId);
    if (index < 0) throw codedError('WORKFLOW_GRAPH_NODE_NOT_FOUND', 'Graph node not found');
    profile.steps[index] = sanitizeGraphNode({ ...profile.steps[index], ...(operation.patch || {}), id: profile.steps[index].id });
  } else if (operation.type === 'removeNode') {
    profile.steps = profile.steps.filter((step) => step.id !== operation.nodeId).map((step) => removeOutgoing(step, operation.nodeId));
  } else if (operation.type === 'addEdge') {
    setEdge(profile.steps, operation.from, operation.to, operation.fromPort || 'out');
  } else if (operation.type === 'removeEdge') {
    profile.steps = profile.steps.map((step) => step.id === operation.from ? removeOutgoing(step, operation.to) : step);
  } else {
    throw codedError('INVALID_GRAPH_OPERATION', 'Unsupported graph operation');
  }
}

function sanitizeGraphNode(node) {
  const allowed = new Set(['id', 'name', 'type', 'selector', 'text', 'message', 'url', 'keys', 'shortcut', 'delayAfterMs', 'condition', 'conditions', 'ifSteps', 'elseSteps', 'next', 'ui', 'timeoutMs']);
  const clean = {};
  for (const [key, value] of Object.entries(node)) if (allowed.has(key)) clean[key] = structuredClone(value);
  clean.id = typeof clean.id === 'string' && clean.id.trim() ? clean.id : `step-${crypto.randomUUID()}`;
  clean.name = typeof clean.name === 'string' && clean.name.trim() ? clean.name.slice(0, 120) : clean.id;
  clean.type = typeof clean.type === 'string' ? clean.type : 'log';
  return clean;
}

function setEdge(steps, from, to, fromPort) {
  if (!steps.some((step) => step.id === from) || !steps.some((step) => step.id === to)) throw codedError('WORKFLOW_GRAPH_NODE_NOT_FOUND', 'Graph edge references missing node');
  const links = graphLinks(steps).filter((link) => !(link.from === from && link.fromPort === fromPort));
  links.push({ from, fromPort, to, toPort: 'in' });
  const next = applyLinksToSteps(steps, links);
  steps.splice(0, steps.length, ...next);
}

function graphLinks(steps) {
  const links = [];
  for (const step of steps) {
    if (step.next) links.push({ from: step.id, fromPort: 'out', to: step.next, toPort: 'in' });
    (step.ifSteps || []).forEach((to) => links.push({ from: step.id, fromPort: 'if-out', to, toPort: 'in' }));
    (step.elseSteps || []).forEach((to) => links.push({ from: step.id, fromPort: 'else-out', to, toPort: 'in' }));
    (step.conditions || []).forEach((condition, index) => condition.next && links.push({ from: step.id, fromPort: `cond-${index}-out`, to: condition.next, toPort: 'in' }));
  }
  return links;
}

function removeOutgoing(step, targetId) {
  const next = { ...step };
  if (next.next === targetId) delete next.next;
  if (Array.isArray(next.ifSteps)) next.ifSteps = next.ifSteps.filter((id) => id !== targetId);
  if (Array.isArray(next.elseSteps)) next.elseSteps = next.elseSteps.filter((id) => id !== targetId);
  if (Array.isArray(next.conditions)) next.conditions = next.conditions.map((condition) => condition.next === targetId ? { ...condition, next: null } : condition);
  return next;
}

function expectedFieldCountFor(definitions) {
  if (!definitions.length) return 0;
  return definitions.reduce((max, definition) => Math.max(max, definition.index), -1) + 1;
}

function redactGroupedPreview(inputs, definitions) {
  const sensitive = new Set(definitions.filter((definition) => definition.sensitive).map((definition) => definition.name));
  return Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, sensitive.has(key) ? '[REDACTED]' : value]));
}

function coerceGroupedInputs(inputs, definitions) {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const coerced = {};
  for (const [key, value] of Object.entries(inputs)) {
    const definition = byName.get(key);
    const type = definition?.type || definition?.schema?.type;
    if (value === '' || type === undefined || typeof value !== 'string') {
      coerced[key] = value;
    } else if (type === 'integer' && /^-?\d+$/.test(value)) {
      coerced[key] = Number(value);
    } else if (type === 'number' && value.trim() !== '' && Number.isFinite(Number(value))) {
      coerced[key] = Number(value);
    } else if (type === 'boolean' && ['true', 'false'].includes(value.toLowerCase())) {
      coerced[key] = value.toLowerCase() === 'true';
    } else {
      coerced[key] = value;
    }
  }
  return coerced;
}

function validateWorkflowInputs(workflow, inputs) {
  assertInputSafe(inputs);
  const definitions = Array.isArray(workflow.requiredInputs) ? workflow.requiredInputs : [];
  if (definitions.some((definition) => definition?.sensitive)) throw codedError('SENSITIVE_INPUT_UNSUPPORTED', 'Sensitive workflow inputs are not supported');
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  for (const key of Object.keys(inputs)) {
    if (!byName.has(key)) throw codedError('UNKNOWN_WORKFLOW_INPUT', 'Workflow input is not defined');
  }
  const sanitized = {};
  for (const definition of definitions) {
    const hasInput = Object.hasOwn(inputs, definition.name);
    if (!hasInput && definition.required && !Object.hasOwn(definition, 'defaultValue')) throw codedError('MISSING_WORKFLOW_INPUT', 'Required workflow input is missing');
    if (!hasInput && Object.hasOwn(definition, 'defaultValue')) {
      sanitized[definition.name] = structuredClone(definition.defaultValue);
      continue;
    }
    if (hasInput) {
      assertInputType(definition, inputs[definition.name]);
      sanitized[definition.name] = structuredClone(inputs[definition.name]);
    }
  }
  assertInputSize(sanitized);
  return sanitized;
}

function assertInputSafe(value, depth = 0) {
  if (depth > MAX_INPUT_DEPTH) throw codedError('WORKFLOW_INPUT_TOO_DEEP', 'Workflow input nesting is too deep');
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) assertInputSafe(item, depth + 1);
    return;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || DANGEROUS_KEYS.has(key)) throw codedError('DANGEROUS_WORKFLOW_INPUT', 'Workflow input contains a dangerous key');
    assertInputSafe(value[key], depth + 1);
  }
}

function assertInputSize(value) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DISPATCH_INPUT_BYTES) throw codedError('WORKFLOW_INPUT_TOO_LARGE', 'Workflow inputs exceed maximum serialized size');
}

function assertInputType(definition, value) {
  const expected = definition.type || definition.schema?.type;
  if (!expected) return;
  const ok = expected === 'array' ? Array.isArray(value)
    : expected === 'integer' ? Number.isInteger(value)
      : expected === 'object' ? isPlainObject(value)
        : typeof value === expected;
  if (!ok) throw codedError('WORKFLOW_INPUT_TYPE_MISMATCH', 'Workflow input type is not compatible with its definition');
}

function sanitizeJob(job) {
  const { inputs: _inputs, dispatchMetadata: _dispatchMetadata, leaseId: _leaseId, ...safe } = job;
  return structuredClone(safe);
}

function sanitizeOriginInventory(payload = {}) {
  const workflows = Array.isArray(payload.workflows) ? payload.workflows.slice(0, 200).map((item) => ({
    workflowId: String(item.workflowId || ''),
    revision: Number.isInteger(item.revision) ? item.revision : 1,
    name: String(item.name || item.workflowId || 'Workflow').slice(0, 200),
    contentHash: String(item.contentHash || ''),
    updatedAt: String(item.updatedAt || item.createdAt || ''),
  })).filter((item) => item.workflowId && /^[a-f0-9]{64}$/.test(item.contentHash)) : [];
  return { workflows };
}

function sanitizeOriginWorkflow(workflow) {
  const clone = structuredClone(workflow || {});
  stripSecretLikeFields(clone);
  clone.contentHash = createWorkflowContentHash(clone);
  return clone;
}

function stripSecretLikeFields(value) {
  if (Array.isArray(value)) return value.forEach(stripSecretLikeFields);
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (/password|passwd|token|secret|credential|cookie/i.test(key)) delete value[key];
    else stripSecretLikeFields(value[key]);
  }
}

function resolveManagedContainerHost(requestedHost, config, manager = null) {
  if (manager) {
    if (requestedHost && manager.getHost(requestedHost)) return requestedHost;
    if (requestedHost) throw codedError('INVALID_CONTAINER_HOST', 'Selected managed Docker host is unavailable');
    return manager.firstHostId();
  }
  if (!config?.enabled) return requestedHost || null;
  const expectedHost = config.hostId || MANAGED_CONTAINER_HOST_ID;
  if (requestedHost && requestedHost !== expectedHost) {
    throw codedError('INVALID_CONTAINER_HOST', 'Selected managed Docker host is unavailable');
  }
  return expectedHost;
}

function managedDockerName(displayName) {
  const base = String(displayName || 'agent')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
    .slice(0, 48) || 'agent';
  return `war-${base}-${crypto.randomUUID().slice(0, 8)}`.slice(0, 80);
}

function managedDeviceDescriptor({ deviceId, displayName }) {
  return {
    deviceId,
    displayName,
    hostName: 'managed-container',
    platform: 'linux',
    architecture: 'x64',
    agentVersion: 'managed',
    extensionVersion: '',
    browserVersion: '',
    protocolVersion: 'v1',
    capabilities: {
      workflowExecution: true,
      semanticControl: true,
      rawViewportInput: true,
      rawBrowserInput: true,
      nativeX11Input: true,
      screenshot: true,
      clipboardText: false,
      remoteVideo: true,
      synchronizedInput: true
    },
    labels: ['managed-container'],
    groupIds: []
  };
}

function randomIpv6Suffix() {
  const bytes = crypto.randomBytes(6);
  bytes[0] = (bytes[0] & 0xfc) | 0x02;
  return ipv6Eui64SuffixFromMacAddress([...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(':'));
}

function isUnprovisionedContainer(container = {}) {
  return container.status === 'failed'
    && container.desiredState === 'stopped'
    || container.status === 'deleted'
      && container.trashedFromStatus === 'failed'
      && container.trashedFromDesiredState === 'stopped';
}

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeContainerError(error) {
  return String(error?.message || error || 'Container operation failed')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(credential|token|password)=\S+/gi, '$1=[REDACTED]')
    .slice(0, 500);
}

function unwrapApplicationResult(result) {
  if (result?.ok === true) return result.data?.data ?? result.data;
  return result;
}

function sanitizeDiagnosticMessage(error) {
  return String(error?.message || error || 'Diagnostic check failed')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(password|token|secret|credential|authorization|identity)=\S+/gi, '$1=[REDACTED]')
    .slice(0, 300);
}

function sanitizeDiagnosticContainer(container) {
  return {
    id: container.id,
    name: container.name,
    status: container.status,
    host: container.host || null,
    deviceId: container.deviceId || null,
    lastError: container.lastError ? sanitizeDiagnosticMessage(container.lastError) : null,
  };
}

function sanitizeDiagnosticSession(session) {
  return {
    deviceId: session.deviceId,
    status: session.status,
    generation: session.generation,
    connectedAt: session.connectedAt,
    lastSeenAt: session.lastSeenAt,
  };
}
