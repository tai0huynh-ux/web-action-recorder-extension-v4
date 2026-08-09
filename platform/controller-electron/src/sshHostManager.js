import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDockerContainerAdapter } from './containerAdapter.js';
import { normalizeControllerHost, requireControllerHost } from './controllerHost.js';
import { isImmutableImagePin } from './runtimeProfileStore.js';

const execFileAsync = promisify(execFile);
const DEFAULT_CA_PATH = '/etc/war/controller-ca.pem';
const DEFAULT_SECCOMP_PATH = '/etc/war/security/chromium-userns-seccomp.json';
const DEFAULT_APPARMOR_PATH = '/etc/apparmor.d/war-browser-agent';
const APPROVED_APPARMOR_SHA256 = 'b6182de92e8ed7cf31350969042be50352136b3d1e5dccaf6d02aebfbcf2be08';
const APPROVED_SECCOMP_SHA256 = '6b0e60321eb4b9d774eb4eee0baa7b03d0c6b6141a593b5312e42356cf510c67';
const REMOTE_CONTROL_IMAGE_LABEL = 'v1';
const BROWSER_ENGINE_IMAGE_LABEL = 'cloakbrowser';
const BROWSER_ENGINE_VERSION_LABEL = '0.5.5';
const BROWSER_BINARY_VERSION_LABEL = '146.0.7680.177.5';
const BROWSER_ARCHIVE_SHA256_LABEL = '4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e';
const MAX_OUTPUT_BYTES = 64 * 1024;
const PROBE_SCRIPT = [
  'set +e',
  'printf "ssh=1\\n"',
  'if command -v docker >/dev/null 2>&1 && docker version --format "{{.Server.Version}}" >/dev/null 2>&1; then printf "docker=1\\n"; else printf "docker=0\\n"; fi',
  'if docker image inspect "$WAR_IMAGE" >/dev/null 2>&1; then printf "image=1\\n"; else printf "image=0\\n"; fi',
  'IMAGE_ID=$(docker image inspect "$WAR_IMAGE" --format "{{.Id}}" 2>/dev/null || true)',
  'IMAGE_REPO_DIGESTS=$(docker image inspect "$WAR_IMAGE" --format "{{join .RepoDigests \\"\\n\\"}}" 2>/dev/null || true)',
  'if test "$WAR_IMAGE" = "$IMAGE_ID" || printf "%s\\n" "$IMAGE_REPO_DIGESTS" | grep -Fxq "$WAR_IMAGE"; then printf "imagePin=1\\n"; else printf "imagePin=0\\n"; fi',
  'IMAGE_REVISION=$(docker image inspect "$WAR_IMAGE" --format "{{index .Config.Labels \\"org.opencontainers.image.revision\\"}}" 2>/dev/null || true)',
  'IMAGE_REMOTE_CONTROL=$(docker image inspect "$WAR_IMAGE" --format "{{index .Config.Labels \\"com.web-action-recorder.remote-control\\"}}" 2>/dev/null || true)',
  'IMAGE_BROWSER_ENGINE=$(docker image inspect "$WAR_IMAGE" --format "{{index .Config.Labels \\"com.web-action-recorder.browser-engine\\"}}" 2>/dev/null || true)',
  'IMAGE_BROWSER_ENGINE_VERSION=$(docker image inspect "$WAR_IMAGE" --format "{{index .Config.Labels \\"com.web-action-recorder.browser-engine-version\\"}}" 2>/dev/null || true)',
  'IMAGE_BROWSER_BINARY_VERSION=$(docker image inspect "$WAR_IMAGE" --format "{{index .Config.Labels \\"com.web-action-recorder.browser-binary-version\\"}}" 2>/dev/null || true)',
  'IMAGE_BROWSER_ARCHIVE_SHA256=$(docker image inspect "$WAR_IMAGE" --format "{{index .Config.Labels \\"com.web-action-recorder.browser-archive-sha256\\"}}" 2>/dev/null || true)',
  `if test "\${#IMAGE_REVISION}" -eq 40 && test -z "$(printf %s "$IMAGE_REVISION" | tr -d '0-9a-f')" && test "$IMAGE_REMOTE_CONTROL" = "${REMOTE_CONTROL_IMAGE_LABEL}" && test "$IMAGE_BROWSER_ENGINE" = "${BROWSER_ENGINE_IMAGE_LABEL}" && test "$IMAGE_BROWSER_ENGINE_VERSION" = "${BROWSER_ENGINE_VERSION_LABEL}" && test "$IMAGE_BROWSER_BINARY_VERSION" = "${BROWSER_BINARY_VERSION_LABEL}" && test "$IMAGE_BROWSER_ARCHIVE_SHA256" = "${BROWSER_ARCHIVE_SHA256_LABEL}"; then printf "imageCurrent=1\\n"; else printf "imageCurrent=0\\n"; fi`,
  `if test -f ${DEFAULT_SECCOMP_PATH} && test ! -L ${DEFAULT_SECCOMP_PATH} && test "$(stat -c %U:%G ${DEFAULT_SECCOMP_PATH} 2>/dev/null)" = root:root && test -z "$(find ${DEFAULT_SECCOMP_PATH} -perm /022 -print -quit 2>/dev/null)" && test "$(sha256sum ${DEFAULT_SECCOMP_PATH} 2>/dev/null | awk '{print $1}')" = ${APPROVED_SECCOMP_SHA256}; then printf "seccomp=1\\n"; else printf "seccomp=0\\n"; fi`,
  `if aa-enabled >/dev/null 2>&1 && test -f ${DEFAULT_APPARMOR_PATH} && test ! -L ${DEFAULT_APPARMOR_PATH} && test "$(stat -c %U:%G ${DEFAULT_APPARMOR_PATH} 2>/dev/null)" = root:root && test -z "$(find ${DEFAULT_APPARMOR_PATH} -perm /022 -print -quit 2>/dev/null)" && test "$(sha256sum ${DEFAULT_APPARMOR_PATH} 2>/dev/null | awk '{print $1}')" = ${APPROVED_APPARMOR_SHA256} && grep -Fxq 'war-browser-agent (enforce)' /sys/kernel/security/apparmor/profiles 2>/dev/null && grep -Fxq 'war-browser-agent//cloakbrowser-launcher (enforce)' /sys/kernel/security/apparmor/profiles 2>/dev/null && grep -Fxq 'war-browser-agent//cloakbrowser-launcher//war-native-host (enforce)' /sys/kernel/security/apparmor/profiles 2>/dev/null; then printf "apparmor=1\\n"; else printf "apparmor=0\\n"; fi`,
  'if test -f "$WAR_CA_PATH" && test ! -L "$WAR_CA_PATH" && test "$(stat -c %U:%G "$WAR_CA_PATH" 2>/dev/null)" = root:root && test -z "$(find "$WAR_CA_PATH" -perm /022 -print -quit 2>/dev/null)"; then printf "ca=1\\n"; else printf "ca=0\\n"; fi',
  'printf "done=1\\n"',
].join('; ');

export class SshContainerHostManager {
  constructor({ config, settingsStore, createAdapter = createDockerContainerAdapter, fsImpl = fs, execFileImpl = execFileAsync, now = () => new Date().toISOString() } = {}) {
    this.config = config || {};
    this.settingsStore = settingsStore;
    this.createAdapter = createAdapter;
    this.fs = fsImpl;
    this.execFile = execFileImpl;
    this.now = now;
    this.hosts = new Map();
    this.trashedHosts = new Map();
    this.purgedHostIds = new Set();
    this.readinessChecks = new Map();
    this.repairOperations = new Map();
  }

  async load() {
    const settings = await this.settingsStore?.get?.() || {};
    this.hosts = new Map((settings.containerHosts || []).map((host) => [host.id, withMainProcessImagePin(host, this.config)]));
    this.trashedHosts = new Map((settings.trashedContainerHosts || []).map((host) => [host.id, structuredClone(host)]));
    this.purgedHostIds = new Set(settings.purgedContainerHostIds || []);
    const legacy = legacyHost(this.config);
    const matchingPersistedTarget = legacy && [...this.hosts.values()].some((host) => host.target === legacy.target);
    if (legacy && !matchingPersistedTarget && !this.hosts.has(legacy.id) && !this.trashedHosts.has(legacy.id) && !this.purgedHostIds.has(legacy.id)) this.hosts.set(legacy.id, legacy);
    return { status: this.hosts.size ? 'configured' : 'unavailable', hosts: [...this.hosts.values()].map(publicHost) };
  }

  async listHosts() {
    const hosts = await Promise.all([...this.hosts.values()].map((host) => this.describeHost(host)));
    const ready = hosts.filter((host) => host.connected);
    return { status: hosts.length === 0 ? 'unavailable' : (ready.length ? 'connected' : 'unavailable'), hosts };
  }

  listTrashedHosts() {
    return { hosts: [...this.trashedHosts.values()].map(publicHost) };
  }

  async addHost(payload = {}) {
    const host = normalizeHostPayload(payload, null, this.configuredImagePin());
    this.assertIdentity(host.identityFile);
    const settings = await this.settingsStore.get();
    const existing = (settings.containerHosts || []).filter((item) => item.id !== host.id);
    const trashed = (settings.trashedContainerHosts || []).filter((item) => item.id !== host.id);
    const purged = (settings.purgedContainerHostIds || []).filter((id) => id !== host.id);
    await this.settingsStore.update({ containerHosts: [...existing, host], trashedContainerHosts: trashed, purgedContainerHostIds: purged });
    this.hosts.set(host.id, host);
    this.trashedHosts.delete(host.id);
    this.purgedHostIds.delete(host.id);
    return this.checkHost(host.id);
  }

  async updateHost(hostId, payload = {}) {
    const current = this.requireHost(hostId);
    const host = normalizeHostPayload({
      name: payload.name ?? current.name,
      target: payload.target ?? current.target,
      identityFile: payload.identityFile || current.identityFile,
      controllerHost: payload.controllerHost ?? current.controllerHost,
      controllerCaPath: payload.controllerCaPath ?? current.controllerCaPath,
      seccompProfilePath: payload.seccompProfilePath ?? current.seccompProfilePath,
      image: payload.image ?? current.imagePin ?? current.image,
      ipv6Interface: payload.ipv6Interface ?? current.ipv6Interface,
      ipv6Prefix: payload.ipv6Prefix ?? current.ipv6Prefix,
      ipv6Driver: payload.ipv6Driver ?? current.ipv6Driver,
    }, hostId, this.configuredImagePin());
    this.assertIdentity(host.identityFile);
    const duplicate = [...this.hosts.values()].find((item) => item.id !== hostId && item.target === host.target);
    if (duplicate) throw Object.assign(new Error('SSH target is already configured'), { code: 'CONTAINER_HOST_TARGET_EXISTS' });
    const settings = await this.settingsStore.get();
    let replaced = false;
    const active = (settings.containerHosts || []).map((item) => {
      if (item.id !== hostId) return item;
      replaced = true;
      return host;
    });
    if (!replaced) active.push(host);
    await this.settingsStore.update({ containerHosts: active });
    this.hosts.set(hostId, host);
    return this.checkHost(hostId);
  }

  async trashHost(hostId) {
    const host = this.requireHost(hostId);
    const settings = await this.settingsStore.get();
    const deleted = { ...host, deletedAt: this.now() };
    const active = (settings.containerHosts || []).filter((item) => item.id !== hostId);
    const trashed = (settings.trashedContainerHosts || []).filter((item) => item.id !== hostId);
    const purged = (settings.purgedContainerHostIds || []).filter((id) => id !== hostId);
    await this.settingsStore.update({ containerHosts: active, trashedContainerHosts: [...trashed, deleted], purgedContainerHostIds: purged });
    this.hosts.delete(hostId);
    this.trashedHosts.set(hostId, deleted);
    this.purgedHostIds.delete(hostId);
    return publicHost(deleted);
  }

  async restoreHost(hostId) {
    const host = this.trashedHosts.get(hostId);
    if (!host) throw Object.assign(new Error('SSH host is not in trash'), { code: 'CONTAINER_HOST_NOT_IN_TRASH' });
    if (this.hosts.has(hostId)) throw Object.assign(new Error('SSH host already exists'), { code: 'CONTAINER_HOST_ALREADY_EXISTS' });
    const settings = await this.settingsStore.get();
    const restored = { ...host };
    delete restored.deletedAt;
    const active = (settings.containerHosts || []).filter((item) => item.id !== hostId);
    const trashed = (settings.trashedContainerHosts || []).filter((item) => item.id !== hostId);
    const purged = (settings.purgedContainerHostIds || []).filter((id) => id !== hostId);
    await this.settingsStore.update({ containerHosts: [...active, restored], trashedContainerHosts: trashed, purgedContainerHostIds: purged });
    this.hosts.set(hostId, restored);
    this.trashedHosts.delete(hostId);
    this.purgedHostIds.delete(hostId);
    return publicHost(restored);
  }

  async purgeHost(hostId) {
    if (!this.trashedHosts.has(hostId)) throw Object.assign(new Error('SSH host is not in trash'), { code: 'CONTAINER_HOST_NOT_IN_TRASH' });
    const settings = await this.settingsStore.get();
    const trashed = (settings.trashedContainerHosts || []).filter((item) => item.id !== hostId);
    const purged = [...new Set([...(settings.purgedContainerHostIds || []), hostId])];
    await this.settingsStore.update({ trashedContainerHosts: trashed, purgedContainerHostIds: purged });
    this.trashedHosts.delete(hostId);
    this.purgedHostIds.add(hostId);
    return { id: hostId, purgedAt: this.now() };
  }

  async checkHost(hostId) {
    const host = this.requireHost(hostId);
    return this.describeHost(host);
  }

  async ensureReady(hostId) {
    const existing = this.readinessChecks.get(hostId);
    if (existing) return existing;
    const readiness = this.checkHost(hostId);
    this.readinessChecks.set(hostId, readiness);
    try {
      return await readiness;
    } finally {
      if (this.readinessChecks.get(hostId) === readiness) this.readinessChecks.delete(hostId);
    }
  }

  async repairHost(hostId) {
    const existing = this.repairOperations.get(hostId);
    if (existing) return existing;
    const repair = this.performRepairHost(hostId);
    this.repairOperations.set(hostId, repair);
    try {
      return await repair;
    } finally {
      if (this.repairOperations.get(hostId) === repair) this.repairOperations.delete(hostId);
    }
  }

  async performRepairHost(hostId) {
    const host = this.requireHost(hostId);
    this.assertIdentity(host.identityFile);
    const checked = await this.describeHost(host, { rethrowTransportError: true });
    const diagnostics = checked.diagnostics || {};
    if (!diagnostics.ssh) {
      throw codedError('SSH_HOST_REPAIR_VERIFY_FAILED', diagnostics.error || 'Linux host could not be verified after repair');
    }
    if (!diagnostics.wss) {
      throw codedError('CONTROLLER_WSS_NOT_CONFIGURED', 'Controller WSS is not configured for this Linux host');
    }
    const imageCheck = host.imagePin ? 'imagePin' : 'imageCurrent';
    const failedChecks = ['docker', 'image', imageCheck, 'apparmor', 'seccomp', 'ca'].filter((key) => diagnostics[key] !== true);
    if (failedChecks.length) {
      throw codedError('HOST_PROVISIONING_REQUIRED', `Linux host needs the approved immutable image and security prerequisites: ${failedChecks.join(', ')}`, { failedChecks });
    }
    return checked;
  }

  getHost(hostId) {
    return this.hosts.get(hostId) || null;
  }

  firstHostId() {
    return this.hosts.keys().next().value || null;
  }

  configuredHostIds() {
    return [...this.hosts.keys()];
  }

  getAdapter(hostId) {
    const host = this.getHost(hostId);
    if (!host) return null;
    return this.createAdapter({ config: this.adapterConfig(host) });
  }

  adapterConfig(host) {
    const baseContainers = this.config.containers || {};
    return {
      ...this.config,
      wss: this.config.wss,
      containers: {
        ...baseContainers,
        enabled: true,
        runtime: 'ssh-docker',
        hostId: host.id,
        hostDisplayName: host.name,
        hostLabel: host.name,
        sshTarget: host.target,
        sshIdentityFile: host.identityFile,
        controllerHost: host.controllerHost || this.config.wss?.host || null,
        controllerCaPath: host.controllerCaPath,
        seccompProfilePath: host.seccompProfilePath,
        image: host.imagePin || host.image,
        imagePin: host.imagePin || null,
        ipv6Interface: host.ipv6Interface,
        ipv6Prefix: host.ipv6Prefix,
        ipv6Driver: host.ipv6Driver,
      },
    };
  }

  async describeHost(host, { rethrowTransportError = false } = {}) {
    const base = publicHost(host);
    try {
      this.assertIdentity(host.identityFile);
      const imagePin = this.hostImagePin(host);
      const result = await this.remote(host, withEnvironment(PROBE_SCRIPT, imagePin, host.controllerCaPath));
      const diagnostics = parseProbe(result.stdout);
      // Image labels describe the build but cannot authorize it. Pinned hosts
      // require the exact local ID or registry digest evidence from the probe.
      const linuxReady = diagnostics.ready === true && (!host.imagePin || diagnostics.imagePin === true);
      diagnostics.linuxReady = linuxReady;
      diagnostics.wss = Boolean(this.config.wss?.enabled && this.config.wss?.port && (host.controllerHost || this.config.wss.host));
      diagnostics.ready = linuxReady && diagnostics.wss;
      if (!diagnostics.wss) diagnostics.error = 'Controller WSS is not configured for this host';
      const status = diagnostics.ready ? 'ready' : (linuxReady && !diagnostics.wss ? 'controller-required' : 'repair-required');
      return { ...base, connected: diagnostics.ready === true, status, diagnostics, checkedAt: this.now() };
    } catch (error) {
      if (rethrowTransportError) throw error;
      return { ...base, connected: false, status: 'unavailable', diagnostics: { ssh: false, ready: false, error: sanitizeError(error) }, checkedAt: this.now() };
    }
  }

  async remote(host, command) {
    const args = [
      '-F', 'NUL',
      '-i', host.identityFile,
      '-o', 'IdentitiesOnly=yes',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '--',
      host.target,
      command,
    ];
    try {
      return await this.execFile('ssh', args, { timeout: 15 * 60 * 1000, maxBuffer: MAX_OUTPUT_BYTES, env: { ...process.env, WAR_IMAGE: this.hostImagePin(host) } });
    } catch (error) {
      throw mapSshCommandError(error);
    }
  }

  assertIdentity(identityFile) {
    if (typeof identityFile !== 'string' || identityFile.length < 1 || identityFile.length > 1024 || /[\r\n]/.test(identityFile)) throw codedError('SSH_IDENTITY_INVALID', 'SSH private key path is invalid');
    if (!this.fs.existsSync(identityFile)) throw codedError('SSH_IDENTITY_NOT_READABLE', 'SSH private key file is not readable');
    const stat = this.fs.statSync(identityFile);
    if (!stat.isFile()) throw codedError('SSH_IDENTITY_NOT_FILE', 'SSH private key path is not a regular file');
  }

  configuredImagePin() {
    const imagePin = this.config?.containers?.imagePin;
    if (this.config?.containers?.enabled && !isImmutableImagePin(imagePin)) throw new Error('Managed SSH host requires an immutable image pin');
    return isImmutableImagePin(imagePin) ? imagePin : null;
  }

  hostImagePin(host) {
    const imagePin = host?.imagePin || (!this.config?.containers?.enabled ? host?.image : null);
    if (!isImmutableImagePin(imagePin)) throw new Error('Managed SSH host requires an immutable image pin');
    return imagePin;
  }

  requireHost(hostId) {
    const host = this.getHost(hostId);
    if (!host) throw Object.assign(new Error('SSH host not found'), { code: 'CONTAINER_HOST_NOT_FOUND' });
    return host;
  }
}

function normalizeHostPayload(payload, fixedId = null, mainProcessImagePin = null) {
  const name = requiredText(payload.name, 1, 80);
  const target = requiredText(payload.target, 3, 255);
  const identityFile = requiredText(payload.identityFile, 1, 1024);
  if (!/^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])$/.test(target)) throw new Error('SSH target is invalid');
  const id = fixedId || `ssh-${crypto.createHash('sha256').update(target).digest('hex').slice(0, 16)}`;
  const suppliedImage = payload.image;
  if (mainProcessImagePin && suppliedImage !== undefined && suppliedImage !== mainProcessImagePin) throw new Error('Managed SSH host requires an immutable image pin');
  if (!mainProcessImagePin) throw new Error('Managed SSH host requires an immutable image pin');
  const image = mainProcessImagePin;
  return {
    id,
    name,
    target,
    identityFile,
    image,
    ...(mainProcessImagePin ? { imagePin: mainProcessImagePin } : {}),
    controllerHost: requireControllerHost(payload.controllerHost),
    controllerCaPath: remotePath(payload.controllerCaPath, DEFAULT_CA_PATH),
    seccompProfilePath: remotePath(payload.seccompProfilePath, DEFAULT_SECCOMP_PATH),
    ipv6Interface: optionalText(payload.ipv6Interface, 32),
    ipv6Prefix: optionalText(payload.ipv6Prefix, 80),
    ipv6Driver: payload.ipv6Driver === 'bridge' ? 'bridge' : 'macvlan',
  };
}

function legacyHost(config) {
  const containers = config.containers;
  if (!containers?.enabled || containers.runtime !== 'ssh-docker' || !containers.sshTarget || !containers.sshIdentityFile) return null;
  const controllerHost = normalizeControllerHost(containers.controllerHost);
  const imagePin = containers.imagePin;
  if (!isImmutableImagePin(imagePin)) return null;
  return {
    id: containers.hostId || 'configured-docker-host',
    name: containers.hostDisplayName || 'Configured Linux host',
    target: containers.sshTarget,
    identityFile: containers.sshIdentityFile,
    image: imagePin,
    imagePin,
    controllerHost,
    controllerCaPath: containers.controllerCaPath || DEFAULT_CA_PATH,
    seccompProfilePath: containers.seccompProfilePath || DEFAULT_SECCOMP_PATH,
    ipv6Interface: containers.ipv6Interface || null,
    ipv6Prefix: containers.ipv6Prefix || null,
    ipv6Driver: containers.ipv6Driver || 'macvlan',
  };
}

function publicHost(host) {
  return {
    id: host.id,
    label: host.name,
    name: host.name,
    target: host.target,
    runtime: 'ssh-docker',
    image: host.imagePin || host.image,
    identityConfigured: Boolean(host.identityFile),
    connected: false,
    ...(host.deletedAt ? { deletedAt: host.deletedAt } : {}),
  };
}

function withEnvironment(command, image, caPath) {
  return `WAR_IMAGE=${shellQuote(image)} WAR_CA_PATH=${shellQuote(caPath)} sh -c ${shellQuote(command)}`;
}

function parseProbe(output = '') {
  const result = { ssh: false, docker: false, image: false, imagePin: false, imageCurrent: false, apparmor: false, seccomp: false, ca: false, ready: false };
  for (const line of String(output).split(/\r?\n/)) {
    const [key, value] = line.split('=', 2);
    if (Object.hasOwn(result, key)) result[key] = value === '1';
  }
  result.ready = result.ssh && result.docker && result.image && (result.imagePin || result.imageCurrent) && result.apparmor && result.seccomp && result.ca;
  return result;
}

function withMainProcessImagePin(host, config) {
  const copy = structuredClone(host);
  const imagePin = config?.containers?.imagePin;
  if (!isImmutableImagePin(imagePin)) return copy;
  const containers = config.containers || {};
  return {
    ...copy,
    image: imagePin,
    imagePin,
    ipv6Interface: copy.ipv6Interface ?? containers.ipv6Interface ?? null,
    ipv6Prefix: copy.ipv6Prefix ?? containers.ipv6Prefix ?? null,
    ipv6Driver: copy.ipv6Driver ?? containers.ipv6Driver ?? 'macvlan',
  };
}

function requiredText(value, min, max) {
  const text = optionalText(value, max);
  if (!text || text.length < min) throw new Error('Required SSH host field is invalid');
  return text;
}

function optionalText(value, max) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('SSH host field is invalid');
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new Error('SSH host field is invalid');
  return text;
}

function remotePath(value, fallback) {
  const text = optionalText(value, 512);
  return text && /^\/[A-Za-z0-9._/-]+$/.test(text) ? text : fallback;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function mapSshCommandError(error) {
  const raw = `${error?.stderr || ''} ${error?.message || ''}`.toLowerCase();
  if (error?.code === 'ENOENT') return codedError('SSH_CLIENT_MISSING', 'The ssh client is not available on the Controller');
  if (error?.code === 'ETIMEDOUT' || error?.killed || error?.signal === 'SIGTERM' || raw.includes('timed out')) {
    return codedError('SSH_TIMEOUT', 'SSH connection or remote command timed out');
  }
  if (raw.includes('permission denied') || raw.includes('no supported authentication methods')) {
    return codedError('SSH_AUTH_FAILED', 'SSH authentication failed; verify the Linux account and private key');
  }
  if (raw.includes('could not resolve hostname') || raw.includes('name or service not known') || raw.includes('getaddrinfo')) {
    return codedError('SSH_DNS_FAILED', 'The Linux host name could not be resolved');
  }
  if (raw.includes('connection refused') || raw.includes('no route to host') || raw.includes('network is unreachable') || raw.includes('unknown error')) {
    return codedError('SSH_UNREACHABLE', 'The Linux host is unreachable on the network');
  }
  return codedError('SSH_HOST_COMMAND_FAILED', 'The remote Linux host check failed');
}

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function sanitizeError(error) {
  return String(error?.message || error || 'SSH host check failed')
    .replace(/(identity|password|token|credential)=\S+/gi, '$1=[REDACTED]')
    .slice(0, 300);
}
