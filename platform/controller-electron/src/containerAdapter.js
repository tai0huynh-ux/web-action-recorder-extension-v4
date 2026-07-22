import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import {
  composeIpv6Address,
  ipv6PrefixFromAddress,
  macAddressFromIpv6Eui64Suffix,
  normalizeIpv6Address,
  normalizeIpv6Eui64Suffix,
  normalizeIpv6Prefix,
  normalizeManagedNetwork,
} from '../../controller-core/src/networkConfig.js';

const execFileAsync = promisify(execFile);
const DEFAULT_IMAGE = 'war-browser-agent:phase1';
const CONTROL_PORT = '3766';
const MANAGED_LABEL = 'war-controller';
const CREDENTIAL_PATH = '/data/device/controller-session.credential';
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const MANAGED_IPV4_NETWORK_PREFIX = 'war-managed-ipv4-';
const MANAGED_IPV6_NETWORK_PREFIX = 'war-managed-ipv6-';
const APPROVED_SECCOMP_CANONICAL_SHA256 = '04ba8f30f2f3b6a10e6b54836363fc9b2a05a55c4aff6ea68c95d8d3f277fd5f';

export function matchesApprovedSeccompSecurityOption(securityOptions) {
  const option = (securityOptions || []).find((value) => String(value).startsWith('seccomp='));
  if (!option) return false;
  try {
    const policy = JSON.parse(String(option).slice('seccomp='.length));
    const hash = crypto.createHash('sha256').update(JSON.stringify(policy)).digest('hex');
    return hash === APPROVED_SECCOMP_CANONICAL_SHA256;
  } catch {
    return false;
  }
}

export function createDockerContainerAdapter({ config, execFileImpl = execFileAsync, spawnImpl = spawn } = {}) {
  const containerConfig = config?.containers;
  if (!containerConfig?.enabled) return null;
  return new DockerContainerAdapter({ config: containerConfig, wss: config?.wss, execFileImpl, spawnImpl });
}

export class DockerContainerAdapter {
  constructor({ config, wss, execFileImpl = execFileAsync, spawnImpl = spawn }) {
    this.config = config;
    this.wss = wss;
    this.execFile = execFileImpl;
    this.spawn = spawnImpl;
  }

  async probe() {
    const version = (await this.docker(['version', '--format', '{{.Server.Version}}'])).stdout.trim();
    if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(version)) {
      throw new Error('Managed Docker host returned an invalid version');
    }
    return { connected: true };
  }

  async create(container) {
    const name = dockerName(container);
    const volume = dataVolume(name);
    const approvedImage = this.approvedImage(container);
    const approvedImageId = await this.imageId(approvedImage);
    const network = await this.resolveDesiredNetwork(name, container.runtime);
    await this.docker(['volume', 'create', volume]);
    let created = false;
    try {
      await this.writeCredential(volume, approvedImage, container.provisioning?.credential);
      await this.launchContainer(container, network, { approvedImage, mode: 'run' });
      created = true;
      await this.waitForIpv6Endpoint(name, network);
      const runtime = await this.inspectRuntime(name, volume, { approvedImage, approvedImageId, network });
      return { runtime, status: 'running' };
    } catch (error) {
      if (created) await this.docker(['rm', '-f', name]).catch(() => {});
      await this.docker(['volume', 'rm', '-f', volume]).catch(() => {});
      for (const managedNetwork of managedNetworkNames(network)) await this.removeManagedNetwork(managedNetwork);
      throw error;
    }
  }

  async start(container) {
    const name = dockerName(container);
    const network = await this.reconcileNetworks(container);
    await this.docker(['start', name]);
    return { runtime: await this.inspectRuntime(name, dataVolume(name), { network }), status: 'running' };
  }

  async stop(container) {
    const name = dockerName(container);
    await this.docker(['stop', '--time', '10', name]);
    return { runtime: await this.inspectRuntime(name, dataVolume(name), { network: this.networkFromRuntime(container.runtime) }), status: 'stopped' };
  }

  async restart(container) {
    const name = dockerName(container);
    const network = await this.reconcileNetworks(container);
    await this.docker(['restart', '--time', '10', name]);
    return { runtime: await this.inspectRuntime(name, dataVolume(name), { network }), status: 'running' };
  }

  async status(container) {
    const name = dockerName(container);
    const state = (await this.docker(['inspect', '-f', '{{.State.Status}}', name])).stdout.trim();
    const network = this.networkFromRuntime(container.runtime);
    const runtime = await this.inspectRuntime(name, dataVolume(name), { network });
    runtime.ipv6PrefixChanged = await this.ipv6PrefixChanged(runtime);
    return { status: mapDockerStatus(state), resourceUsage: await this.resourceUsage(name), runtime };
  }

  async updateNetwork(container) {
    const name = dockerName(container);
    const network = await this.reconcileNetworks(container);
    const state = (await this.docker(['inspect', '-f', '{{.State.Status}}', name])).stdout.trim();
    return { status: mapDockerStatus(state), runtime: await this.inspectRuntime(name, dataVolume(name), { network }) };
  }

  async delete(container) {
    const name = dockerName(container);
    const networks = await this.containerNetworkNames(name).catch(() => []);
    await this.docker(['rm', '-f', name]);
    await this.docker(['volume', 'rm', '-f', dataVolume(name)]);
    for (const network of networks.filter(isManagedNetwork)) await this.removeManagedNetwork(network);
    await this.removeManagedNetwork(managedIpv4NetworkName(name));
    return { status: 'deleted', runtime: { dockerName: name } };
  }

  environment(container) {
    const entries = [
      ['WAR_MANAGED_DEVICE_ID', container.deviceId],
      ['WAR_CONTROLLER_SESSION_CREDENTIAL_FILE', CREDENTIAL_PATH],
      ['WAR_CONTROLLER_WSS_URL', this.controllerWssUrl()],
    ];
    if (this.config.controllerCaPath) {
      entries.push(['NODE_EXTRA_CA_CERTS', '/run/war/controller-ca.pem']);
    }
    const filteredEntries = entries.filter(([, value]) => value !== undefined && value !== null && value !== '');
    const mountArgs = [];
    if (this.config.controllerCaPath) {
      mountArgs.push('-v', `${this.config.controllerCaPath}:/run/war/controller-ca.pem:ro`);
    }
    return { entries: filteredEntries, mountArgs };
  }

  async launchContainer(container, network, { approvedImage = this.approvedImage(container), mode = 'run' } = {}) {
    const name = dockerName(container);
    const volume = dataVolume(name);
    const environment = this.environment(container);
    const args = [
      mode,
      ...(mode === 'run' ? ['-d'] : []),
      '--name', name,
      '--label', `managed-by=${MANAGED_LABEL}`,
      '--restart', 'unless-stopped',
      '--memory', '2g',
      '--cpus', '2',
      '--pids-limit', '512',
      '--user', 'war',
      '--security-opt', 'apparmor=war-browser-agent',
      '--security-opt', `seccomp=${this.seccompProfilePath()}`,
      ...containerNetworkArgs(network),
      '-p', `127.0.0.1::${CONTROL_PORT}`,
      '-v', `${volume}:/data`,
      '--add-host', 'host.docker.internal:host-gateway',
      ...environment.mountArgs,
      approvedImage,
    ];
    await this.dockerRun(args, environment.entries);
  }

  controllerWssUrl() {
    if (!this.wss?.enabled) return null;
    const host = this.config.controllerHost || this.wss.host;
    const port = this.wss.port;
    if (!host || !port) return null;
    return `wss://${host}:${port}/v1/agent-session`;
  }

  seccompProfilePath() {
    const value = this.config.seccompProfilePath;
    if (typeof value !== 'string' || value.length < 2 || value.length > 512 || /[\r\n]/.test(value)) {
      throw new Error('Managed container seccomp profile path is invalid');
    }
    if (this.config.runtime === 'ssh-docker' && !/^\/[A-Za-z0-9._/-]+$/.test(value)) {
      throw new Error('Managed SSH container seccomp profile path must be absolute');
    }
    return value;
  }

  approvedImage(container) {
    const approved = this.config.image || DEFAULT_IMAGE;
    if (container?.image && container.image !== approved) throw new Error('Managed container image is not approved');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(approved)) throw new Error('Invalid approved Docker image');
    return approved;
  }

  async imageId(approvedImage) {
    const result = await this.docker(['image', 'inspect', '--format', '{{.Id}}', approvedImage]);
    const id = result.stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('Approved Docker image ID is invalid');
    return id;
  }

  async writeCredential(volume, approvedImage, credential) {
    if (typeof credential !== 'string' || credential.length < 24 || /[\r\n]/.test(credential)) {
      throw new Error('Managed container credential is invalid');
    }
    const args = [
      'run', '--rm', '-i', '--user', 'war',
      '-v', `${volume}:/data`,
      '--entrypoint', '/bin/sh', approvedImage,
      '-c', `umask 077; mkdir -p /data/device; cat > ${CREDENTIAL_PATH}`,
    ];
    await this.dockerWithInput(args, `${credential}\n`);
  }

  async resolveDesiredNetwork(name, runtime = {}) {
    const preferences = normalizeManagedNetwork(runtime);
    const ipv4Network = managedIpv4NetworkName(name);
    if (preferences.ipv4Enabled) await this.ensureManagedIpv4Network(ipv4Network);
    if (!preferences.ipv6Enabled) {
      return { ...preferences, ipv4Network, ipv6Driver: null, ipv6MacAddress: null, ipv6Prefix: null, ipv6Address: null, ipv6Network: null };
    }

    const ipv6Suffix = this.config.ipv6Driver === 'macvlan' ? normalizeIpv6Eui64Suffix(preferences.ipv6Suffix) : preferences.ipv6Suffix;
    const discovery = await this.discoverIpv6Prefix();
    const ipv6Interface = this.config.ipv6Interface || discovery.interfaceName;
    if (this.config.ipv6Driver === 'macvlan' && !ipv6Interface) throw new Error('No IPv6 interface is available for macvlan');
    const ipv6Address = composeIpv6Address(discovery.prefix, ipv6Suffix);
    if (this.config.ipv6Driver !== 'macvlan' && discovery.hostAddresses.includes(normalizeIpv6Address(ipv6Address))) {
      throw new Error('Managed container IPv6 address conflicts with the Docker host');
    }
    const ipv6Network = managedIpv6NetworkName(discovery.prefix, this.config.ipv6Driver);
    await this.ensureManagedIpv6Network(ipv6Network, discovery.prefix, ipv6Interface);
    return {
      ...preferences,
      ipv4Network,
      ipv6Suffix,
      ipv6Driver: this.config.ipv6Driver,
      ipv6Interface,
      ipv6MacAddress: this.config.ipv6Driver === 'macvlan' ? macAddressFromIpv6Eui64Suffix(ipv6Suffix) : null,
      ipv6Prefix: discovery.prefix,
      ipv6Address,
      ipv6Network,
    };
  }

  networkFromRuntime(runtime = {}) {
    const preferences = normalizeManagedNetwork(runtime);
    const ipv4Network = runtime.ipv4Network && isManagedIpv4Network(runtime.ipv4Network) ? runtime.ipv4Network : 'bridge';
    if (!preferences.ipv6Enabled) return { ...preferences, ipv4Network, ipv6Driver: null, ipv6MacAddress: null, ipv6Prefix: null, ipv6Address: null, ipv6Network: null };
    const ipv6Driver = runtime.ipv6Driver || this.config.ipv6Driver;
    const ipv6Suffix = ipv6Driver === 'macvlan' ? normalizeIpv6Eui64Suffix(preferences.ipv6Suffix) : preferences.ipv6Suffix;
    const ipv6Prefix = normalizeIpv6Prefix(runtime.ipv6Prefix);
    const ipv6Address = normalizeIpv6Address(runtime.ipv6Address);
    const ipv6Network = String(runtime.ipv6Network || '');
    if (!['bridge', 'macvlan'].includes(ipv6Driver) || !isManagedIpv6Network(ipv6Network) || ipv6Address !== composeIpv6Address(ipv6Prefix, ipv6Suffix)) {
      throw new Error('Managed container IPv6 runtime is invalid');
    }
    return {
      ...preferences,
      ipv4Network,
      ipv6Suffix,
      ipv6Driver,
      ipv6MacAddress: ipv6Driver === 'macvlan' ? macAddressFromIpv6Eui64Suffix(ipv6Suffix) : null,
      ipv6Prefix,
      ipv6Address,
      ipv6Network,
    };
  }

  async discoverIpv6Prefix() {
    if (this.config.ipv6Prefix && this.config.ipv6Driver !== 'macvlan') return { prefix: normalizeIpv6Prefix(this.config.ipv6Prefix), hostAddresses: [], interfaceName: null };
    const args = ['ip', '-6', '-j', 'address', 'show'];
    if (this.config.ipv6Interface) args.push('dev', this.config.ipv6Interface);
    args.push('scope', 'global');
    const result = await this.hostCommand(args);
    let links;
    try {
      links = JSON.parse(result.stdout.trim());
    } catch {
      throw new Error('Managed IPv6 host address response is invalid');
    }
    const candidates = (Array.isArray(links) ? links : []).flatMap((link) => (link.addr_info || []).map((item) => ({ ...item, ifname: link.ifname })))
      .filter((item) => item?.family === 'inet6' && item.scope === 'global' && item.prefixlen === 64 && item.local && item.deprecated !== true && item.tentative !== true);
    const prefixes = [...new Set(candidates.map((item) => ipv6PrefixFromAddress(item.local, item.prefixlen)))];
    const configuredPrefix = this.config.ipv6Prefix ? normalizeIpv6Prefix(this.config.ipv6Prefix) : null;
    if (configuredPrefix && !prefixes.includes(configuredPrefix)) throw new Error('Configured IPv6 prefix is not present on the selected host interface');
    if (prefixes.length === 0) throw new Error('No global IPv6 /64 prefix is available on the Docker host');
    if (!configuredPrefix && prefixes.length > 1) throw new Error('Multiple global IPv6 /64 prefixes found; configure WAR_CONTAINER_IPV6_INTERFACE');
    const selectedPrefix = configuredPrefix || prefixes[0];
    return {
      prefix: selectedPrefix,
      hostAddresses: candidates.map((item) => normalizeIpv6Address(item.local)),
      interfaceName: candidates.find((item) => ipv6PrefixFromAddress(item.local, item.prefixlen) === selectedPrefix)?.ifname || null,
    };
  }

  async ensureManagedIpv6Network(name, prefix, ipv6Interface) {
    try {
      const result = await this.docker(['network', 'inspect', '--format', '{{json .}}', name]);
      let inspection;
      try { inspection = JSON.parse(result.stdout.trim()); } catch { inspection = null; }
      if (!inspection) throw Object.assign(new Error('No such network'), { stderr: 'No such network' });
      const subnets = (inspection.IPAM?.Config || []).map((item) => item.Subnet).filter(Boolean);
      const bridgeSafe = inspection.Driver === 'bridge' && inspection.EnableIPv6 === true && subnets.includes(prefix);
      const macvlanSafe = inspection.Driver === 'macvlan'
        && inspection.EnableIPv6 === true
        && inspection.Options?.parent === ipv6Interface
        && subnets.includes(prefix);
      if ((!bridgeSafe && !macvlanSafe) || inspection.Labels?.['managed-by'] !== MANAGED_LABEL || inspection.Labels?.['war-ipv6-prefix'] !== prefix) {
        throw new Error('Managed IPv6 Docker network security policy failed');
      }
      return;
    } catch (error) {
      const detail = `${error?.stderr || ''} ${error?.message || ''}`;
      if (!/no such network|not found/i.test(detail)) throw error;
    }
    const args = this.config.ipv6Driver === 'macvlan'
      ? ['network', 'create', '--driver', 'macvlan', '--ipv4=false', '--ipv6', '--subnet', prefix, '--opt', `parent=${ipv6Interface}`]
      : ['network', 'create', '--driver', 'bridge', '--ipv4=false', '--ipv6', '--subnet', prefix];
    await this.docker([...args, '--label', `managed-by=${MANAGED_LABEL}`, '--label', `war-ipv6-prefix=${prefix}`, name]);
  }

  async ensureManagedIpv4Network(name) {
    try {
      const result = await this.docker(['network', 'inspect', '--format', '{{json .}}', name]);
      let inspection;
      try { inspection = JSON.parse(result.stdout.trim()); } catch { inspection = null; }
      if (!inspection) throw Object.assign(new Error('No such network'), { stderr: 'No such network' });
      if (inspection.Driver !== 'bridge' || inspection.EnableIPv4 !== true || inspection.Labels?.['managed-by'] !== MANAGED_LABEL) {
        throw new Error('Managed IPv4 Docker network security policy failed');
      }
      return;
    } catch (error) {
      const detail = `${error?.stderr || ''} ${error?.message || ''}`;
      if (!/no such network|not found/i.test(detail)) throw error;
    }
    await this.docker(['network', 'create', '--driver', 'bridge', '--label', `managed-by=${MANAGED_LABEL}`, '--label', 'war-ipv4-family=true', name]);
  }

  async reconcileNetworks(container) {
    const name = dockerName(container);
    const desired = await this.resolveDesiredNetwork(name, container.runtime);
    const approvedImage = this.approvedImage(container);
    const approvedImageId = await this.imageId(approvedImage);
    const inspection = await this.inspectContainer(name);
    const actual = inspection.NetworkSettings?.Networks || {};
    const imageMatches = inspection.Config?.Image === approvedImage && inspection.Image === approvedImageId;
    if (networkMatches(actual, desired) && imageMatches) return desired;
    const wasRunning = (await this.docker(['inspect', '-f', '{{.State.Running}}', name])).stdout.trim() === 'true';
    const backupName = networkBackupName(name);
    if (wasRunning) await this.docker(['stop', '--time', '10', name]);
    await this.docker(['rename', name, backupName]);
    try {
      await this.launchContainer(container, desired, { approvedImage, mode: wasRunning ? 'run' : 'create' });
      await this.waitForIpv6Endpoint(name, desired);
      await this.inspectRuntime(name, dataVolume(name), { approvedImage, approvedImageId, network: desired });
      await this.docker(['rm', '-f', backupName]);
    } catch (error) {
      await this.docker(['rm', '-f', name]).catch(() => {});
      await this.docker(['rename', backupName, name]).catch(() => {});
      if (wasRunning) await this.docker(['start', name]).catch(() => {});
      throw error;
    }
    const staleNetworks = Object.keys(actual).filter((network) => isManagedNetwork(network) && !managedNetworkNames(desired).includes(network));
    for (const network of staleNetworks) await this.removeManagedNetwork(network);
    return desired;
  }

  async waitForIpv6Endpoint(name, network) {
    if (!network.ipv6Enabled || network.ipv6Driver !== 'macvlan') return;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const inspection = await this.inspectContainer(name);
      const actual = inspection.NetworkSettings?.Networks?.[network.ipv6Network];
      if (matchesIpv6Endpoint(actual, network.ipv6Address)) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Managed macvlan container did not receive the expected IPv6 SLAAC address');
  }

  async ipv6PrefixChanged(runtime) {
    if (!runtime.ipv6Enabled) return false;
    const discovery = await this.discoverIpv6Prefix();
    return discovery.prefix !== runtime.ipv6Prefix;
  }

  async containerNetworkNames(name) {
    const inspection = await this.inspectContainer(name);
    return Object.keys(inspection.NetworkSettings?.Networks || {});
  }

  async inspectContainer(name) {
    const result = await this.docker(['inspect', '--format', '{{json .}}', name]);
    try {
      return JSON.parse(result.stdout.trim());
    } catch {
      throw new Error('Managed container inspect response is invalid');
    }
  }

  async removeManagedNetwork(name) {
    if (!isManagedNetwork(name)) return;
    await this.docker(['network', 'rm', name]).catch(() => {});
  }

  async inspectRuntime(name, volume, { approvedImage, approvedImageId, network = this.networkFromRuntime({}) } = {}) {
    const inspection = await this.inspectContainer(name);
    const host = inspection.HostConfig || {};
    const config = inspection.Config || {};
    const actualNetworks = inspection.NetworkSettings?.Networks || {};
    const actualNetworkNames = Object.keys(actualNetworks);
    const binds = Array.isArray(host.Binds) ? host.Binds : [];
    const securityOptions = Array.isArray(host.SecurityOpt) ? host.SecurityOpt : [];
    const portBindings = host.PortBindings?.[`${CONTROL_PORT}/tcp`] || [];
    const safe = config.User === 'war'
      && host.Privileged === false
      && host.NetworkMode !== 'host'
      && actualNetworkNames.length > 0
      && actualNetworkNames.every((name) => name === network.ipv4Network || name === 'bridge' || name === network.ipv6Network)
      && Boolean(actualNetworks[network.ipv4Network]) === network.ipv4Enabled
      && (!network.ipv4Enabled || network.ipv4Network === 'bridge' || actualNetworks[network.ipv4Network]?.IPAddress)
      && (!network.ipv6Enabled || matchesIpv6Endpoint(actualNetworks[network.ipv6Network], network.ipv6Address))
      && (!network.ipv6Enabled || actualNetworks[network.ipv6Network]?.GlobalIPv6PrefixLen === 64)
      && securityOptions.includes('apparmor=war-browser-agent')
      && matchesApprovedSeccompSecurityOption(securityOptions)
      && host.Memory === 2 * 1024 * 1024 * 1024
      && host.NanoCpus === 2_000_000_000
      && host.PidsLimit === 512
      && binds.some((bind) => bind === `${volume}:/data`)
      && binds.every((bind) => safeBind(bind, volume, this.config.controllerCaPath))
      && portBindings.length > 0
      && portBindings.every((binding) => binding.HostIp === '127.0.0.1')
      && config.Labels?.['managed-by'] === MANAGED_LABEL
      && (!approvedImage || config.Image === approvedImage)
      && (!approvedImageId || inspection.Image === approvedImageId);
    if (!safe) throw new Error('Managed container runtime security policy failed');
    return {
      dockerName: name,
      dataVolume: volume,
      networkMode: host.NetworkMode,
      nonRootUser: config.User,
      privileged: host.Privileged,
      memoryBytes: host.Memory,
      nanoCpus: host.NanoCpus,
      pidsLimit: host.PidsLimit,
      controlPort: parsePortBinding(portBindings),
      host: this.config.hostLabel,
      ipv4Enabled: network.ipv4Enabled,
      ipv4Network: network.ipv4Network === 'bridge' ? null : network.ipv4Network,
      ipv6Enabled: network.ipv6Enabled,
      ipv6Suffix: network.ipv6Suffix,
      ipv6Driver: network.ipv6Driver,
      ipv6MacAddress: network.ipv6MacAddress,
      ipv6Prefix: network.ipv6Prefix,
      ipv6Address: network.ipv6Address,
      ipv6Network: network.ipv6Network,
      ipv6PrefixChanged: false,
    };
  }

  async resourceUsage(name) {
    const result = await this.docker(['stats', '--no-stream', '--format', '{{json .}}', name]).catch(() => ({ stdout: '' }));
    if (!result.stdout.trim()) return null;
    try {
      const stats = JSON.parse(result.stdout.trim());
      return {
        cpuPercent: parsePercent(stats.CPUPerc),
        memoryBytes: parseBytes(String(stats.MemUsage || '').split('/')[0]),
        memoryLimitBytes: parseBytes(String(stats.MemUsage || '').split('/')[1]),
      };
    } catch {
      return null;
    }
  }

  hostCommand(args) {
    const [file, ...commandArgs] = args;
    if (this.config.runtime === 'local-docker') {
      return this.execFile(file, commandArgs, { timeout: this.config.timeoutMs });
    }
    if (this.config.runtime === 'ssh-docker') {
      return this.execFile('ssh', this.sshArgs(shellJoin(args)), { timeout: this.config.timeoutMs });
    }
    throw new Error('Unsupported container runtime');
  }

  docker(args) {
    if (this.config.runtime === 'local-docker') {
      return this.execFile('docker', args, { timeout: this.config.timeoutMs });
    }
    if (this.config.runtime === 'ssh-docker') {
      return this.execFile('ssh', this.sshArgs(shellJoin(['docker', ...args])), { timeout: this.config.timeoutMs });
    }
    throw new Error('Unsupported container runtime');
  }

  dockerRun(args, entries) {
    if (this.config.runtime === 'local-docker') {
      const environmentArgs = entries.flatMap(([key]) => ['-e', key]);
      const imageIndex = args.length - 1;
      return this.execFile('docker', [...args.slice(0, imageIndex), ...environmentArgs, args[imageIndex]], {
        timeout: this.config.timeoutMs,
        env: { ...process.env, ...Object.fromEntries(entries) },
      });
    }
    if (this.config.runtime === 'ssh-docker') {
      const imageIndex = args.length - 1;
      const remoteArgs = [...args.slice(0, imageIndex), '--env-file', '/dev/stdin', args[imageIndex]];
      return spawnWithInput(this.spawn, 'ssh', this.sshArgs(shellJoin(['docker', ...remoteArgs])), {
        input: encodeEnvironment(entries),
        timeoutMs: this.config.timeoutMs,
      });
    }
    throw new Error('Unsupported container runtime');
  }

  dockerWithInput(args, input) {
    if (this.config.runtime === 'local-docker') {
      return spawnWithInput(this.spawn, 'docker', args, { input, timeoutMs: this.config.timeoutMs });
    }
    if (this.config.runtime === 'ssh-docker') {
      return spawnWithInput(this.spawn, 'ssh', this.sshArgs(shellJoin(['docker', ...args])), {
        input,
        timeoutMs: this.config.timeoutMs,
      });
    }
    throw new Error('Unsupported container runtime');
  }

  sshArgs(command) {
    const identityFile = this.config.sshIdentityFile;
    if (typeof identityFile !== 'string' || identityFile.length < 1 || identityFile.length > 1024 || /[\r\n]/.test(identityFile)) {
      throw new Error('Managed SSH identity file is invalid');
    }
    return [
      '-F', 'NUL',
      '-i', identityFile,
      '-o', 'IdentitiesOnly=yes',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      this.config.sshTarget,
      '--', command,
    ];
  }
}

function dockerName(container) {
  const name = container?.runtime?.dockerName || container?.id;
  if (!NAME_PATTERN.test(String(name || ''))) throw new Error('Invalid Docker container name');
  return String(name);
}

function dataVolume(name) {
  return `${name}-data`;
}

function managedIpv6NetworkName(prefix, driver = 'bridge') {
  const hash = crypto.createHash('sha256').update(`${driver}:${normalizeIpv6Prefix(prefix)}`).digest('hex').slice(0, 12);
  return `${MANAGED_IPV6_NETWORK_PREFIX}${hash}`;
}

function managedIpv4NetworkName(containerName) {
  const hash = crypto.createHash('sha256').update(String(containerName)).digest('hex').slice(0, 12);
  return `${MANAGED_IPV4_NETWORK_PREFIX}${hash}`;
}

function networkBackupName(containerName) {
  const hash = crypto.createHash('sha256').update(`backup:${containerName}`).digest('hex').slice(0, 8);
  return `${String(containerName).slice(0, 55)}-network-backup-${hash}`;
}

function isManagedIpv4Network(name) {
  return typeof name === 'string' && name.startsWith(MANAGED_IPV4_NETWORK_PREFIX) && NAME_PATTERN.test(name);
}

function isManagedNetwork(name) {
  return isManagedIpv4Network(name) || isManagedIpv6Network(name);
}

function managedNetworkNames(network) {
  return [network.ipv4Network, network.ipv6Network].filter(isManagedNetwork);
}

function containerNetworkArgs(network) {
  const args = [];
  if (network.ipv4Enabled) args.push('--network', `name=${network.ipv4Network}`);
  if (network.ipv6Enabled) {
    const options = [`name=${network.ipv6Network}`, `ip6=${network.ipv6Address}`];
    if (network.ipv6MacAddress) options.push(`mac-address=${network.ipv6MacAddress}`);
    args.push('--network', options.join(','));
  }
  return args;
}

function networkMatches(actual, desired) {
  const expected = new Set([desired.ipv4Enabled ? desired.ipv4Network : null, desired.ipv6Enabled ? desired.ipv6Network : null].filter(Boolean));
  const names = Object.keys(actual);
  if (names.length !== expected.size || names.some((name) => !expected.has(name))) return false;
  if (desired.ipv6Enabled && !matchesIpv6Endpoint(actual[desired.ipv6Network], desired.ipv6Address)) return false;
  if (desired.ipv6Enabled && desired.ipv6Driver === 'macvlan' && actual[desired.ipv6Network]?.MacAddress?.toLowerCase() !== desired.ipv6MacAddress) return false;
  return true;
}

function isManagedIpv6Network(name) {
  return typeof name === 'string' && name.startsWith(MANAGED_IPV6_NETWORK_PREFIX) && NAME_PATTERN.test(name);
}

function matchesIpv6Endpoint(network, address) {
  try {
    return Boolean(network) && normalizeIpv6Address(network.GlobalIPv6Address) === address;
  } catch {
    return false;
  }
}

function mapDockerStatus(status) {
  if (status === 'running') return 'running';
  if (['created', 'restarting'].includes(status)) return 'starting';
  if (['removing', 'dead'].includes(status)) return 'failed';
  return 'stopped';
}

function parsePort(value) {
  const match = String(value || '').match(/:(\d+)\s*$/);
  return match ? Number(match[1]) : null;
}

function parsePortBinding(bindings) {
  const value = bindings[0]?.HostPort;
  return /^\d+$/.test(String(value || '')) ? Number(value) : null;
}

function safeBind(bind, volume, controllerCaPath) {
  if (bind === `${volume}:/data`) return true;
  return Boolean(controllerCaPath && bind === `${controllerCaPath}:/run/war/controller-ca.pem:ro`);
}

function parsePercent(value) {
  const number = Number(String(value || '').replace('%', '').trim());
  return Number.isFinite(number) ? number : null;
}

function parseBytes(value) {
  const match = String(value || '').trim().match(/^([\d.]+)\s*([KMGT]?i?B)?$/i);
  if (!match) return null;
  const unit = (match[2] || 'B').toLowerCase();
  const factor = unit.startsWith('k') ? 1024 : unit.startsWith('m') ? 1024 ** 2 : unit.startsWith('g') ? 1024 ** 3 : unit.startsWith('t') ? 1024 ** 4 : 1;
  return Math.round(Number(match[1]) * factor);
}

function shellJoin(args) {
  return args.map((arg) => `'${String(arg).replace(/'/g, `'\\''`)}'`).join(' ');
}

function encodeEnvironment(entries) {
  return `${entries.map(([key, value]) => {
    const text = String(value);
    if (!/^[A-Z0-9_]+$/.test(key) || /[\r\n]/.test(text)) throw new Error('Invalid managed container environment');
    return `${key}=${text}`;
  }).join('\n')}\n`;
}

function spawnWithInput(spawnImpl, file, args, { input, timeoutMs, maxOutputBytes = 1024 * 1024 }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const collect = (chunks, kind) => (chunk) => {
      const buffer = Buffer.from(chunk);
      if (kind === 'stdout') stdoutBytes += buffer.length;
      else stderrBytes += buffer.length;
      if (stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes) {
        child.kill();
        finish(new Error('Managed container command output limit exceeded'));
        return;
      }
      chunks.push(buffer);
    };
    child.stdout?.on('data', collect(stdout, 'stdout'));
    child.stderr?.on('data', collect(stderr, 'stderr'));
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      if (code === 0) finish(null, result);
      else finish(Object.assign(new Error('Managed container command failed'), { code, ...result }));
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('Managed container command timed out'));
    }, timeoutMs);
    child.stdin?.on('error', (error) => finish(error));
    child.stdin?.end(input);
  });
}
