import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDockerContainerAdapter } from './containerAdapter.js';

const execFileAsync = promisify(execFile);
const DEFAULT_IMAGE = 'war-browser-agent:phase1';
const DEFAULT_CA_PATH = '/etc/war/controller-ca.pem';
const DEFAULT_SECCOMP_PATH = '/etc/war/security/chromium-userns-seccomp.json';
const DEFAULT_SOURCE_ROOT = '/opt/war/web-action-recorder-extension-v4';
const SOURCE_REPOSITORY = 'https://github.com/tai0huynh-ux/web-action-recorder-extension-v4.git';
const APPROVED_APPARMOR_SHA256 = '0d28cf5e412992d3cb1bc8759bb6cf9cf1602e9aee54ebef52046f3f9b9b710d';
const APPROVED_SECCOMP_SHA256 = 'e11ad80b10af89cdade31962005da51dae8cd8828c0d9c02dadf67008aa5181d';
const MAX_OUTPUT_BYTES = 64 * 1024;
const PROBE_SCRIPT = [
  'set +e',
  'printf "ssh=1\\n"',
  'if command -v docker >/dev/null 2>&1 && docker version --format "{{.Server.Version}}" >/dev/null 2>&1; then printf "docker=1\\n"; else printf "docker=0\\n"; fi',
  'if docker image inspect "$WAR_IMAGE" >/dev/null 2>&1; then printf "image=1\\n"; else printf "image=0\\n"; fi',
  'if test -f "$WAR_SOURCE/platform/browser-agent/Dockerfile"; then printf "source=1\\n"; else printf "source=0\\n"; fi',
  `if test -f ${DEFAULT_SECCOMP_PATH} && test ! -L ${DEFAULT_SECCOMP_PATH} && test "$(stat -c %U:%G ${DEFAULT_SECCOMP_PATH} 2>/dev/null)" = root:root && test -z "$(find ${DEFAULT_SECCOMP_PATH} -perm /022 -print -quit 2>/dev/null)" && test "$(sha256sum ${DEFAULT_SECCOMP_PATH} 2>/dev/null | awk '{print $1}')" = ${APPROVED_SECCOMP_SHA256} && python3 -m json.tool ${DEFAULT_SECCOMP_PATH} >/dev/null 2>&1; then printf "seccomp=1\\n"; else printf "seccomp=0\\n"; fi`,
  `if aa-enabled >/dev/null 2>&1 && test -f /etc/apparmor.d/containers/war-browser-agent && test ! -L /etc/apparmor.d/containers/war-browser-agent && test "$(stat -c %U:%G /etc/apparmor.d/containers/war-browser-agent 2>/dev/null)" = root:root && test -z "$(find /etc/apparmor.d/containers/war-browser-agent -perm /022 -print -quit 2>/dev/null)" && test "$(sha256sum /etc/apparmor.d/containers/war-browser-agent 2>/dev/null | awk '{print $1}')" = ${APPROVED_APPARMOR_SHA256} && grep -Fxq "war-browser-agent (enforce)" /sys/kernel/security/apparmor/profiles 2>/dev/null; then printf "apparmor=1\\n"; else printf "apparmor=0\\n"; fi`,
  'if test -f "$WAR_CA_PATH" && test ! -L "$WAR_CA_PATH" && test "$(stat -c %U:%G "$WAR_CA_PATH" 2>/dev/null)" = root:root && test -z "$(find "$WAR_CA_PATH" -perm /022 -print -quit 2>/dev/null)"; then printf "ca=1\\n"; else printf "ca=0\\n"; fi',
  'printf "done=1\\n"',
].join('; ');

const REPAIR_SCRIPT = [
  'set -eu',
  'if [ "$(id -u)" -eq 0 ]; then SUDO=""; elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then SUDO="sudo -n"; else printf "ROOT_OR_PASSWORDLESS_SUDO_REQUIRED\\n" >&2; exit 20; fi',
  'if ! command -v git >/dev/null 2>&1 || ! command -v docker >/dev/null 2>&1 || ! command -v apparmor_parser >/dev/null 2>&1 || ! command -v aa-status >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then $SUDO apt-get update; DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y --no-install-recommends git docker.io apparmor apparmor-utils python3; fi',
  '$SUDO systemctl enable --now docker >/dev/null 2>&1 || $SUDO service docker start >/dev/null 2>&1 || true',
  '$SUDO mkdir -p /opt/war',
  `if test -d ${DEFAULT_SOURCE_ROOT}/.git; then git -C ${DEFAULT_SOURCE_ROOT} fetch --depth 1 origin main; git -C ${DEFAULT_SOURCE_ROOT} merge --ff-only FETCH_HEAD; else if test -e ${DEFAULT_SOURCE_ROOT}; then $SUDO mv ${DEFAULT_SOURCE_ROOT} ${DEFAULT_SOURCE_ROOT}.backup.$(date +%s); fi; $SUDO git clone --depth 1 ${SOURCE_REPOSITORY} ${DEFAULT_SOURCE_ROOT}; fi`,
  `$SUDO mkdir -p /etc/apparmor.d/containers ${DEFAULT_SECCOMP_PATH.substring(0, DEFAULT_SECCOMP_PATH.lastIndexOf('/'))}`,
  `$SUDO install -o root -g root -m 0644 ${DEFAULT_SOURCE_ROOT}/platform/container/security/war-browser-agent.apparmor /etc/apparmor.d/containers/war-browser-agent`,
  `$SUDO install -o root -g root -m 0644 ${DEFAULT_SOURCE_ROOT}/platform/container/security/chromium-userns-seccomp.json ${DEFAULT_SECCOMP_PATH}`,
  `$SUDO apparmor_parser -r -W /etc/apparmor.d/containers/war-browser-agent`,
  `if ! docker image inspect "$WAR_IMAGE" >/dev/null 2>&1; then $SUDO docker build --pull=false -f ${DEFAULT_SOURCE_ROOT}/platform/browser-agent/Dockerfile -t "$WAR_IMAGE" ${DEFAULT_SOURCE_ROOT}; fi`,
  'printf "repair=1\\n"',
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
  }

  async load() {
    const settings = await this.settingsStore?.get?.() || {};
    this.hosts = new Map((settings.containerHosts || []).map((host) => [host.id, structuredClone(host)]));
    this.trashedHosts = new Map((settings.trashedContainerHosts || []).map((host) => [host.id, structuredClone(host)]));
    this.purgedHostIds = new Set(settings.purgedContainerHostIds || []);
    const legacy = legacyHost(this.config);
    if (legacy && !this.hosts.has(legacy.id) && !this.trashedHosts.has(legacy.id) && !this.purgedHostIds.has(legacy.id)) this.hosts.set(legacy.id, legacy);
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
    const host = normalizeHostPayload(payload);
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

  async repairHost(hostId) {
    const host = this.requireHost(hostId);
    this.assertIdentity(host.identityFile);
    await this.remote(host, withEnvironment(REPAIR_SCRIPT, host.image, host.controllerCaPath));
    return this.describeHost(host);
  }

  getHost(hostId) {
    return this.hosts.get(hostId) || null;
  }

  firstHostId() {
    return this.hosts.keys().next().value || null;
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
        image: host.image,
        ipv6Interface: host.ipv6Interface,
        ipv6Prefix: host.ipv6Prefix,
        ipv6Driver: host.ipv6Driver,
      },
    };
  }

  async describeHost(host) {
    const base = publicHost(host);
    try {
      this.assertIdentity(host.identityFile);
      const result = await this.remote(host, withEnvironment(PROBE_SCRIPT, host.image, host.controllerCaPath));
      const diagnostics = parseProbe(result.stdout);
      diagnostics.wss = Boolean(this.config.wss?.enabled && this.config.wss?.port && (host.controllerHost || this.config.wss.host));
      diagnostics.ready = diagnostics.ready === true && diagnostics.wss;
      if (!diagnostics.wss) diagnostics.error = 'Controller WSS is not configured for this host';
      return { ...base, connected: diagnostics.ready === true, status: diagnostics.ready ? 'ready' : 'repair-required', diagnostics, checkedAt: this.now() };
    } catch (error) {
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
      host.target,
      '--', command,
    ];
    return this.execFile('ssh', args, { timeout: 15 * 60 * 1000, maxBuffer: MAX_OUTPUT_BYTES, env: { ...process.env, WAR_IMAGE: host.image, WAR_SOURCE: DEFAULT_SOURCE_ROOT } });
  }

  assertIdentity(identityFile) {
    if (typeof identityFile !== 'string' || identityFile.length < 1 || identityFile.length > 1024 || /[\r\n]/.test(identityFile)) throw new Error('SSH identity file is invalid');
    if (!this.fs.existsSync(identityFile)) throw new Error('SSH identity file is not readable');
    const stat = this.fs.statSync(identityFile);
    if (!stat.isFile()) throw new Error('SSH identity file is not a regular file');
  }

  requireHost(hostId) {
    const host = this.getHost(hostId);
    if (!host) throw Object.assign(new Error('SSH host not found'), { code: 'CONTAINER_HOST_NOT_FOUND' });
    return host;
  }
}

function normalizeHostPayload(payload) {
  const name = requiredText(payload.name, 1, 80);
  const target = requiredText(payload.target, 3, 255);
  const identityFile = requiredText(payload.identityFile, 1, 1024);
  if (!/^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])$/.test(target)) throw new Error('SSH target is invalid');
  const id = `ssh-${crypto.createHash('sha256').update(target).digest('hex').slice(0, 16)}`;
  const image = requiredText(payload.image || DEFAULT_IMAGE, 1, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(image)) throw new Error('Docker image is invalid');
  return {
    id,
    name,
    target,
    identityFile,
    image,
    controllerHost: requiredText(payload.controllerHost, 3, 255),
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
  return {
    id: containers.hostId || 'configured-docker-host',
    name: containers.hostDisplayName || 'Configured Linux host',
    target: containers.sshTarget,
    identityFile: containers.sshIdentityFile,
    image: containers.image || DEFAULT_IMAGE,
    controllerHost: containers.controllerHost || null,
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
    image: host.image,
    identityConfigured: Boolean(host.identityFile),
    connected: false,
    ...(host.deletedAt ? { deletedAt: host.deletedAt } : {}),
  };
}

function withEnvironment(command, image, caPath) {
  return `WAR_IMAGE=${shellQuote(image)} WAR_SOURCE=${shellQuote(DEFAULT_SOURCE_ROOT)} WAR_CA_PATH=${shellQuote(caPath)} sh -c ${shellQuote(command)}`;
}

function parseProbe(output = '') {
  const result = { ssh: false, docker: false, image: false, source: false, apparmor: false, seccomp: false, ca: false, ready: false };
  for (const line of String(output).split(/\r?\n/)) {
    const [key, value] = line.split('=', 2);
    if (Object.hasOwn(result, key)) result[key] = value === '1';
  }
  result.ready = result.ssh && result.docker && result.image && result.source && result.apparmor && result.seccomp && result.ca;
  return result;
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

function sanitizeError(error) {
  return String(error?.message || error || 'SSH host check failed')
    .replace(/(identity|password|token|credential)=\S+/gi, '$1=[REDACTED]')
    .slice(0, 300);
}
