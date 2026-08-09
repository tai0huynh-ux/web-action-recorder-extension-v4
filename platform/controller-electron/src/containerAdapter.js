import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import {
  composeIpv6Address,
  ipv6PrefixFromAddress,
  macAddressFromIpv6Eui64Suffix,
  normalizeIpv6Address,
  normalizeIpv6Eui64Suffix,
  ipv6Eui64SuffixFromMacAddress,
  normalizeIpv6Prefix,
  normalizeManagedNetwork,
} from '../../controller-core/src/networkConfig.js';
import { normalizeControllerHost, requireControllerHost } from './controllerHost.js';
import { isImmutableImagePin } from './runtimeProfileStore.js';

const execFileAsync = promisify(execFile);
const MANAGED_LABEL = 'war-controller';
const MANAGED_CONTAINER_ID_LABEL = 'war-container-id';
const MANAGED_CONTAINER_NAME_LABEL = 'war-container-name';
const MANAGED_NETWORK_VERSION_LABEL = 'war-network-version';
const MANAGED_NETWORK_KIND_LABEL = 'war-network-kind';
const MANAGED_NETWORK_HOST_LABEL = 'war-network-host';
const MANAGED_NETWORK_FAMILY_LABEL = 'war-network-family';
const MANAGED_NETWORK_PREFIX_LABEL = 'war-network-prefix';
const MANAGED_NETWORK_DRIVER_LABEL = 'war-network-driver';
const MANAGED_NETWORK_VERSION = '1';
const MANAGED_NETWORK_KIND = 'container-network';
const CREDENTIAL_PATH = '/data/device/controller-session.credential';
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const VOLUME_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MANAGED_IPV4_NETWORK_PREFIX = 'war-managed-ipv4-';
const MANAGED_IPV6_NETWORK_PREFIX = 'war-managed-ipv6-';
const APPROVED_SECCOMP_CANONICAL_SHA256 = '03ec0820f970cede78001a6b54e574dbc4c2bc0de05cdb53247102ac84cb3189';

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
    this.imageEnvironmentCache = new Map();
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
    let approvedImageId = null;
    let managedVolume = null;
    let network = null;
    let created = null;
    try {
      // Validate the deterministic volume before provisioning any other resource.
      managedVolume = await this.ensureManagedDataVolume(volume, container);
      network = await this.resolveDesiredNetwork(name, container.runtime);
      // Re-attest after setup and immediately before secret-bearing helper work.
      approvedImageId = await this.imageId(approvedImage);
      await this.writeCredential(volume, approvedImageId, container.provisioning?.credential);
      const launchedDockerId = await this.launchContainer(container, network, { approvedImage: approvedImageId, mode: 'run' });
      // Capture stable ownership before waiting for a macvlan endpoint, which may
      // legitimately not exist yet. Cleanup remains pinned to this Docker ID.
      created = { dockerId: launchedDockerId };
      await this.inspectOwnedCandidate(created.dockerId, container, approvedImage, { approvedImageId });
      await this.inspectCanonicalOwnership(name, container, approvedImage, { expectedDockerId: created.dockerId, approvedImageId });
      await this.waitForIpv6Endpoint(name, network, { expectedDockerId: created.dockerId });
      const runtime = await this.inspectRuntime(name, volume, {
        approvedImage, approvedImageId, network, container, expectedDockerId: created.dockerId,
      });
      return { runtime, status: 'running' };
    } catch (error) {
      if (created) await this.removeOwnedCandidate(created.dockerId, container, approvedImage, { approvedImageId }).catch(() => {});
      if (managedVolume?.created) await this.removeManagedDataVolume(managedVolume).catch(() => {});
      if (network) {
        for (const managedNetwork of managedNetworkNames(network)) await this.removeManagedNetwork(managedNetwork).catch(() => {});
      }
      throw error;
    }
  }

  async start(container) {
    const name = dockerName(container);
    const approvedImage = this.approvedImage(container);
    const approvedImageId = await this.imageId(approvedImage);
    const network = await this.reconcileNetworks(container, { approvedImage, approvedImageId });
    const canonical = await this.inspectCanonicalOwnership(name, container, approvedImage, { approvedImageId });
    await this.docker(['start', canonical.dockerId]);
    await this.waitForIpv6Endpoint(name, network, { expectedDockerId: canonical.dockerId });
    return { runtime: await this.inspectRuntime(name, dataVolume(name), { approvedImage, approvedImageId, network, container, expectedDockerId: canonical.dockerId }), status: 'running' };
  }

  async stop(container) {
    const name = dockerName(container);
    const approvedImage = this.approvedImage(container);
    const approvedImageId = await this.imageId(approvedImage);
    const canonical = await this.inspectCanonicalOwnership(name, container, approvedImage, { approvedImageId });
    await this.docker(['stop', '--time', '10', canonical.dockerId]);
    return { runtime: await this.inspectRuntime(name, dataVolume(name), { approvedImage, approvedImageId, network: this.networkFromRuntime(container.runtime), container, expectedDockerId: canonical.dockerId }), status: 'stopped' };
  }

  async restart(container) {
    const name = dockerName(container);
    const approvedImage = this.approvedImage(container);
    const approvedImageId = await this.imageId(approvedImage);
    const network = await this.reconcileNetworks(container, { approvedImage, approvedImageId });
    const canonical = await this.inspectCanonicalOwnership(name, container, approvedImage, { approvedImageId });
    await this.docker(['restart', '--time', '10', canonical.dockerId]);
    await this.waitForIpv6Endpoint(name, network, { expectedDockerId: canonical.dockerId });
    return { runtime: await this.inspectRuntime(name, dataVolume(name), { approvedImage, approvedImageId, network, container, expectedDockerId: canonical.dockerId }), status: 'running' };
  }

  async repair(container) {
    const name = dockerName(container);
    const approvedImage = this.approvedImage(container);
    const approvedImageId = await this.imageId(approvedImage);
    const network = await this.reconcileNetworks(container, { approvedImage, approvedImageId });
    const runtime = await this.inspectRuntime(name, dataVolume(name), { approvedImage, approvedImageId, network, container });
    const state = (await this.docker(['inspect', '-f', '{{.State.Status}}', name])).stdout.trim();
    return { runtime, status: mapDockerStatus(state) };
  }

  async status(container) {
    const name = dockerName(container);
    const approvedImage = this.approvedImage(container);
    const approvedImageId = await this.imageId(approvedImage);
    const state = (await this.docker(['inspect', '-f', '{{.State.Status}}', name])).stdout.trim();
    const network = this.networkFromRuntime(container.runtime);
    const runtime = await this.inspectRuntime(name, dataVolume(name), { approvedImage, approvedImageId, network, container });
    runtime.ipv6PrefixChanged = await this.ipv6PrefixChanged(runtime);
    return { status: mapDockerStatus(state), resourceUsage: await this.resourceUsage(name), runtime };
  }

  async updateNetwork(container) {
    const name = dockerName(container);
    const approvedImage = this.approvedImage(container);
    const approvedImageId = await this.imageId(approvedImage);
    const network = await this.reconcileNetworks(container, { approvedImage, approvedImageId });
    const state = (await this.docker(['inspect', '-f', '{{.State.Status}}', name])).stdout.trim();
    return { status: mapDockerStatus(state), runtime: await this.inspectRuntime(name, dataVolume(name), { approvedImage, approvedImageId, network, container }) };
  }

  async delete(container) {
    const name = dockerName(container);
    const approvedImage = this.approvedImage(container);
    const approvedImageId = await this.imageId(approvedImage);
    const canonical = await this.inspectCanonicalOwnership(name, container, approvedImage, { approvedImageId });
    await this.inspectOwnedCandidate(canonical.dockerId, container, approvedImage, { approvedImageId });
    let volume = null;
    let preservedVolume = false;
    try {
      volume = await this.inspectManagedDataVolume(dataVolume(name), container);
    } catch (error) {
      const legacyVolume = await this.inspectLegacyDataVolume(dataVolume(name));
      if (!legacyVolume) throw error;
      preservedVolume = true;
    }
    const networkNames = await this.containerNetworkNames(canonical.dockerId);
    const networkNamesToRemove = new Set([
      ...networkNames.filter(isManagedNetwork),
      managedIpv4NetworkName(name),
    ]);
    const networks = [];
    const preservedNetworks = [];
    for (const network of networkNamesToRemove) {
      try {
        networks.push(await this.captureManagedNetwork(network));
      } catch (error) {
        const legacyNetwork = await this.inspectLegacyManagedNetwork(network);
        if (!legacyNetwork) throw error;
        preservedNetworks.push(network);
      }
    }
    // All owned artifacts are now validated before the first destructive action.
    await this.docker(['rm', '-f', canonical.dockerId]);
    if (volume) await this.removeManagedDataVolume(volume);
    for (const network of networks) await this.removeManagedNetwork(network);
    return {
      status: 'deleted',
      runtime: { dockerName: name },
      ...(preservedVolume || preservedNetworks.length ? { preserved: { volume: preservedVolume, networks: preservedNetworks.slice(0, 16) } } : {}),
    };
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
      ...(container.id ? ['--label', `${MANAGED_CONTAINER_ID_LABEL}=${safeLabel(container.id)}`] : []),
      ...(container.name ? ['--label', `${MANAGED_CONTAINER_NAME_LABEL}=${safeLabel(container.name)}`] : []),
      ...(container.deviceId ? ['--label', `war-device-id=${safeLabel(container.deviceId)}`] : []),
      '--restart', 'unless-stopped',
      '--memory', '2g',
      '--cpus', '2',
      '--pids-limit', '512',
      '--cap-drop', 'ALL',
      '--user', 'war',
      '--security-opt', 'apparmor=war-browser-agent',
      '--security-opt', `seccomp=${this.seccompProfilePath()}`,
      ...containerNetworkArgs(network),
      '-v', `${volume}:/data`,
      ...this.controllerHostGatewayArgs(),
      ...environment.mountArgs,
      approvedImage,
    ];
    const launched = await this.dockerRun(args, environment.entries);
    // Docker run/create prints the immutable full container ID. Capture it at the
    // launch boundary so a mutable deterministic name cannot be swapped first.
    return dockerObjectId(String(launched?.stdout || '').trim());
  }

  controllerWssUrl() {
    if (!this.wss?.enabled) return null;
    const host = this.config.controllerHost || this.wss.host;
    const port = this.wss.port;
    if (!host || !port) return null;
    return `wss://${requireControllerHost(host)}:${port}/v1/agent-session`;
  }

  controllerHostGatewayArgs() {
    const host = normalizeControllerHost(this.config.controllerHost || this.wss?.host);
    return host?.toLowerCase() === 'host.docker.internal'
      ? ['--add-host', 'host.docker.internal:host-gateway']
      : [];
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
    const approved = this.config.imagePin || this.config.image;
    if (container?.image && container.image !== approved) throw new Error('Managed container image is not approved');
    if (!isImmutableImagePin(approved)) throw new Error('Managed container requires an immutable image pin');
    return approved;
  }

  async attestImage(container) {
    const imagePin = this.approvedImage(container);
    return { imagePin, imageId: await this.imageId(imagePin) };
  }

  async imageId(approvedImage) {
    if (!isImmutableImagePin(approvedImage)) throw new Error('Managed container requires an immutable image pin');
    const result = await this.docker(['image', 'inspect', '--format', '{{.Id}}', approvedImage]);
    const id = result.stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('Approved Docker image ID is invalid');
    if (/^sha256:/i.test(approvedImage) && id !== approvedImage) {
      throw new Error('Docker image ID does not match the configured immutable pin');
    }
    return id;
  }

  async imageEnvironment(approvedImageId) {
    if (this.imageEnvironmentCache.has(approvedImageId)) return this.imageEnvironmentCache.get(approvedImageId);
    const result = await this.docker(['image', 'inspect', '--format', '{{json .Config.Env}}', approvedImageId]);
    let entries;
    try {
      entries = JSON.parse(result.stdout.trim());
    } catch {
      throw new Error('Approved Docker image environment is invalid');
    }
    const environment = parseEnvironment(entries === null ? [] : entries);
    if (!environment) throw new Error('Approved Docker image environment is invalid');
    this.imageEnvironmentCache.set(approvedImageId, environment);
    return environment;
  }

  async writeCredential(volume, approvedImage, credential) {
    if (typeof credential !== 'string' || credential.length < 24 || /[\r\n]/.test(credential)) {
      throw new Error('Managed container credential is invalid');
    }
    const args = [
      'run', '--rm', '-i', ...this.helperContainerArgs(), '--user', 'war',
      '-v', `${volume}:/data`,
      '--entrypoint', '/bin/sh', approvedImage,
      '-c', `umask 077; mkdir -p /data/device; cat > ${CREDENTIAL_PATH}`,
    ];
    await this.dockerWithInput(args, `${credential}\n`);
  }

  helperContainerArgs() {
    return [
      '--network', 'none',
      '--read-only',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true',
      '--security-opt', 'apparmor=war-browser-agent',
      '--security-opt', `seccomp=${this.seccompProfilePath()}`,
      '--memory', '128m',
      '--cpus', '0.25',
      '--pids-limit', '64',
    ];
  }

  async resolveDesiredNetwork(name, runtime = {}, { legacyAttachedNetworks = new Set(), legacyCanonicalDockerId = null, legacyCanonicalRunning = null, measuredIpv4MacAddress = null } = {}) {
    const preferences = normalizeManagedNetwork(runtime);
    const canonicalIpv4Network = managedIpv4NetworkName(name);
    const legacyIpv4Network = attachedLegacyIpv4Network({
      runtime,
      canonicalIpv4Network,
      attachedNetworks: legacyAttachedNetworks,
      canonicalDockerId: legacyCanonicalDockerId,
    });
    const ipv4Network = legacyIpv4Network || canonicalIpv4Network;
    // Persisted endpoint identity wins; a live MAC only migrates older records.
    const ipv4MacAddress = preferences.ipv4Enabled
      ? (normalizeOptionalIpv4MacAddress(runtime.ipv4MacAddress) || normalizeOptionalIpv4MacAddress(measuredIpv4MacAddress))
      : null;
    if (preferences.ipv4Enabled) {
      await this.ensureManagedIpv4Network(ipv4Network, {
        legacyAttachment: legacyIpv4Network
          ? {
            canonicalDockerId: legacyCanonicalDockerId,
            canonicalContainerName: name,
            canonicalRunning: legacyCanonicalRunning,
            canonicalNetworkNames: legacyAttachedNetworks,
          }
          : null,
      });
    }
    if (!preferences.ipv6Enabled) {
      return { ...preferences, ipv4Network, ipv4MacAddress, ipv6Driver: null, ipv6MacAddress: null, ipv6Prefix: null, ipv6Address: null, ipv6Network: null };
    }

    const ipv6Suffix = this.config.ipv6Driver === 'macvlan' ? normalizeIpv6Eui64Suffix(preferences.ipv6Suffix) : preferences.ipv6Suffix;
    const discovery = await this.discoverIpv6Prefix();
    const ipv6Interface = this.config.ipv6Interface || discovery.interfaceName;
    if (this.config.ipv6Driver === 'macvlan' && !ipv6Interface) throw new Error('No IPv6 interface is available for macvlan');
    const ipv6Address = composeIpv6Address(discovery.prefix, ipv6Suffix);
    if (this.config.ipv6Driver !== 'macvlan' && discovery.hostAddresses.includes(normalizeIpv6Address(ipv6Address))) {
      throw new Error('Managed container IPv6 address conflicts with the Docker host');
    }
    const canonicalIpv6Network = managedIpv6NetworkName(discovery.prefix, this.config.ipv6Driver);
    const legacyIpv6Network = attachedLegacyIpv6Network({
      runtime,
      canonicalIpv6Network,
      discoveryPrefix: discovery.prefix,
      driver: this.config.ipv6Driver,
      expectedAddress: ipv6Address,
      attachedNetworks: legacyAttachedNetworks,
    });
    const ipv6Network = legacyIpv6Network || canonicalIpv6Network;
    await this.ensureManagedIpv6Network(ipv6Network, discovery.prefix, ipv6Interface, { allowLegacyAttached: Boolean(legacyIpv6Network) });
    return {
      ...preferences,
      ipv4Network,
      ipv4MacAddress,
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
    const ipv4MacAddress = preferences.ipv4Enabled ? normalizeOptionalIpv4MacAddress(runtime.ipv4MacAddress) : null;
    if (!preferences.ipv6Enabled) return { ...preferences, ipv4Network, ipv4MacAddress, ipv6Driver: null, ipv6MacAddress: null, ipv6Prefix: null, ipv6Address: null, ipv6Network: null };
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
      ipv4MacAddress,
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

  async ensureManagedIpv6Network(name, prefix, ipv6Interface, { allowLegacyAttached = false } = {}) {
    const capability = this.networkCapability({ family: 'ipv6', prefix, driver: this.config.ipv6Driver });
    try {
      const result = await this.docker(['network', 'inspect', '--format', '{{json .}}', name]);
      let inspection;
      try { inspection = JSON.parse(result.stdout.trim()); } catch { inspection = null; }
      if (!inspection) throw Object.assign(new Error('No such network'), { stderr: 'No such network' });
      const subnets = (inspection.IPAM?.Config || []).map((item) => item.Subnet).filter(Boolean);
      const bridgeSafe = inspection.Driver === 'bridge' && inspection.EnableIPv4 !== true && inspection.EnableIPv6 === true && subnets.includes(prefix);
      const macvlanSafe = inspection.Driver === 'macvlan'
        && inspection.EnableIPv4 !== true
        && inspection.EnableIPv6 === true
        && inspection.Options?.parent === ipv6Interface
        && subnets.includes(prefix);
      if ((!bridgeSafe && !macvlanSafe) || (!this.matchesNetworkCapability(inspection, name, capability) && !(allowLegacyAttached && this.matchesLegacyNetwork(inspection, name)))) {
        throw new Error('Managed network ownership policy failed');
      }
      return;
    } catch (error) {
      const detail = `${error?.stderr || ''} ${error?.message || ''}`;
      if (!/no such network|not found/i.test(detail)) throw error;
    }
    const args = this.config.ipv6Driver === 'macvlan'
      ? ['network', 'create', '--driver', 'macvlan', '--ipv4=false', '--ipv6', '--subnet', prefix, '--opt', `parent=${ipv6Interface}`]
      : ['network', 'create', '--driver', 'bridge', '--ipv4=false', '--ipv6', '--subnet', prefix];
    await this.docker([...args, ...networkLabelArgs(capability), name]);
  }

  async ensureManagedIpv4Network(name, { legacyAttachment = null } = {}) {
    const capability = this.networkCapability({ family: 'ipv4', prefix: 'none', driver: 'bridge' });
    try {
      const result = await this.docker(['network', 'inspect', '--format', '{{json .}}', name]);
      let inspection;
      try { inspection = JSON.parse(result.stdout.trim()); } catch { inspection = null; }
      if (!inspection) throw Object.assign(new Error('No such network'), { stderr: 'No such network' });
      const legacyCompatible = legacyAttachment
        && this.matchesLegacyIpv4Network(inspection, name, legacyAttachment);
      if (inspection.Driver !== 'bridge' || inspection.EnableIPv4 !== true || inspection.EnableIPv6 === true || (!this.matchesNetworkCapability(inspection, name, capability) && !legacyCompatible)) {
        throw new Error('Managed network ownership policy failed');
      }
      return;
    } catch (error) {
      const detail = `${error?.stderr || ''} ${error?.message || ''}`;
      if (!/no such network|not found/i.test(detail)) throw error;
    }
    await this.docker(['network', 'create', '--driver', 'bridge', ...networkLabelArgs(capability), name]);
  }

  networkCapability({ family, prefix, driver }) {
    return {
      [MANAGED_NETWORK_VERSION_LABEL]: MANAGED_NETWORK_VERSION,
      [MANAGED_NETWORK_KIND_LABEL]: MANAGED_NETWORK_KIND,
      [MANAGED_NETWORK_HOST_LABEL]: safeLabel(this.config.hostId || this.config.hostLabel || this.config.runtime),
      [MANAGED_NETWORK_FAMILY_LABEL]: family,
      [MANAGED_NETWORK_PREFIX_LABEL]: prefix,
      [MANAGED_NETWORK_DRIVER_LABEL]: driver,
    };
  }

  matchesNetworkCapability(inspection, name, capability = null) {
    const labels = inspection?.Labels || {};
    const base = inspection?.Name === name
      && labels['managed-by'] === MANAGED_LABEL
      && labels[MANAGED_NETWORK_VERSION_LABEL] === MANAGED_NETWORK_VERSION
      && labels[MANAGED_NETWORK_KIND_LABEL] === MANAGED_NETWORK_KIND
      && labels[MANAGED_NETWORK_HOST_LABEL] === safeLabel(this.config.hostId || this.config.hostLabel || this.config.runtime);
    if (!base) return false;
    if (capability) return Object.entries(capability).every(([key, value]) => labels[key] === value);
    const family = labels[MANAGED_NETWORK_FAMILY_LABEL];
    const driver = labels[MANAGED_NETWORK_DRIVER_LABEL];
    const prefix = labels[MANAGED_NETWORK_PREFIX_LABEL];
    if (family === 'ipv4') {
      return driver === 'bridge' && prefix === 'none'
        && inspection.Driver === 'bridge' && inspection.EnableIPv4 === true && inspection.EnableIPv6 !== true;
    }
    if (family !== 'ipv6' || !['bridge', 'macvlan'].includes(driver) || inspection.Driver !== driver) return false;
    try {
      const normalizedPrefix = normalizeIpv6Prefix(prefix);
      const subnets = (inspection.IPAM?.Config || []).map((item) => item.Subnet).filter(Boolean);
      const macvlanMatches = driver !== 'macvlan'
        || (!this.config.ipv6Interface || inspection.Options?.parent === this.config.ipv6Interface);
      return inspection.EnableIPv6 === true && subnets.includes(normalizedPrefix) && macvlanMatches
        && managedIpv6NetworkName(normalizedPrefix, driver) === name;
    } catch {
      return false;
    }
  }

  matchesLegacyNetwork(inspection, name) {
    return inspection?.Name === name && inspection?.Labels?.['managed-by'] === MANAGED_LABEL;
  }

  matchesLegacyIpv4Network(inspection, name, {
    canonicalDockerId, canonicalContainerName, canonicalRunning, canonicalNetworkNames,
  } = {}) {
    const labels = inspection?.Labels;
    const containers = inspection?.Containers;
    if (inspection?.Name !== name
      || !hasExactLabels(labels, { 'managed-by': MANAGED_LABEL, 'war-ipv4-family': 'true' })
      || inspection?.Scope !== 'local'
      || inspection?.Internal !== false
      || inspection?.Ingress !== false
      || inspection?.Driver !== 'bridge'
      || inspection?.EnableIPv4 !== true
      || inspection?.EnableIPv6 === true
      || !hasValidIpv4Ipam(inspection?.IPAM)
      || !isCanonicalDockerId(canonicalDockerId)
      || typeof canonicalContainerName !== 'string'
      || !NAME_PATTERN.test(canonicalContainerName)
      || !containers
      || typeof containers !== 'object'
      || Array.isArray(containers)) return false;

    const endpoints = Object.entries(containers);
    if (endpoints.length === 0) {
      return canonicalRunning === false
        && canonicalNetworkNames instanceof Set
        && canonicalNetworkNames.has(name);
    }
    if (endpoints.length !== 1) return false;
    const [endpointDockerId, endpoint] = endpoints[0];
    return endpointDockerId === canonicalDockerId
      && endpoint?.Name === canonicalContainerName
      && isCanonicalEndpoint(endpoint, inspection.IPAM.Config[0].Subnet);
  }

  async reconcileNetworks(container, { approvedImage: resolvedApprovedImage = null, approvedImageId: resolvedApprovedImageId = null } = {}) {
    const name = dockerName(container);
    const approvedImage = resolvedApprovedImage || this.approvedImage(container);
    const approvedImageId = resolvedApprovedImageId || await this.imageId(approvedImage);
    const recovery = await this.recoverInterruptedBackup(container);
    // Only a network already attached to this verified canonical container may
    // use the legacy compatibility path; new provisioning remains strict.
    // Do not require the resolved ID here: a stale tagged image is precisely a
    // repair candidate. The final replacement/runtime attestation is digest-pinned.
    const canonicalForLegacy = await this.inspectCanonicalOwnership(name, container, approvedImage, { allowRecoveredDigest: true });
    // Keep legacy attachment evidence from this ownership-attested inspect, so
    // a name swap cannot make an empty post-reboot endpoint look trustworthy.
    const legacyAttachedNetworks = new Set(canonicalForLegacy.networkNames);
    let desired = await this.resolveDesiredNetwork(name, container.runtime, {
      legacyAttachedNetworks,
      legacyCanonicalDockerId: canonicalForLegacy.dockerId,
      legacyCanonicalRunning: canonicalForLegacy.running,
      measuredIpv4MacAddress: canonicalForLegacy.ipv4MacAddress,
    });
    let actual = {};
    const currentMatches = async () => {
      const inspection = await this.inspectContainer(name);
      actual = inspection.NetworkSettings?.Networks || {};
      const stopped = inspection.State?.Running === false;
      const imageMatches = matchesApprovedImage(inspection.Config?.Image, inspection.Image, approvedImage, approvedImageId);
      if (!networkMatches(actual, desired, { stopped }) || !imageMatches) return false;
      try {
        await this.inspectRuntime(name, dataVolume(name), { approvedImage, approvedImageId, network: desired, container });
        return true;
      } catch {
        // The network/image can be correct while security options or mounts drifted.
        return false;
      }
    };
    if (await currentMatches()) {
      await this.cleanupRecoveryArtifacts(recovery, container);
      return desired;
    }
    if (recovery?.hold && !recovery.backup) {
      await this.removeRecoveryArtifact(recovery.hold, container);
      recovery.hold = null;
    }
    // A repair may correct runtime drift, but only a stable WAR identity can be
    // stopped or renamed. Use its immutable Docker ID to close name reuse races.
    const canonical = await this.inspectCanonicalOwnership(name, container, approvedImage, { allowRecoveredDigest: true });
    desired = { ...desired, ipv4MacAddress: desired.ipv4MacAddress || canonical.ipv4MacAddress };
    if (desired.ipv4Enabled && desired.ipv4Network !== 'bridge' && !desired.ipv4MacAddress) {
      throw new Error('Managed container IPv4 MAC address is unavailable for replacement');
    }
    const wasRunning = (await this.docker(['inspect', '-f', '{{.State.Running}}', canonical.dockerId])).stdout.trim() === 'true';
    const displacedName = recovery?.backup ? networkRecoveryHoldName(name) : networkBackupName(name);
    if (recovery?.hold) {
      await this.removeRecoveryArtifact(recovery.hold, container);
      recovery.hold = null;
    }
    if (wasRunning) await this.docker(['stop', '--time', '10', canonical.dockerId]);
    await this.docker(['rename', canonical.dockerId, displacedName]);
    const displaced = { name: displacedName, dockerId: canonical.dockerId, canonicalName: name };
    let replacement = null;
    try {
      const launchedDockerId = await this.launchContainer(container, desired, { approvedImage: approvedImageId, mode: wasRunning ? 'run' : 'create' });
      // Capture the replacement ID before a macvlan endpoint becomes available.
      // Every subsequent wait, validation, and rollback is pinned to that ID.
      replacement = {
        name,
        dockerId: launchedDockerId,
        network: desired,
      };
      await this.inspectOwnedCandidate(replacement.dockerId, container, approvedImage, { approvedImageId });
      await this.inspectCanonicalOwnership(name, container, approvedImage, { expectedDockerId: replacement.dockerId, approvedImageId });
      if (wasRunning) await this.waitForIpv6Endpoint(name, desired, { expectedDockerId: replacement.dockerId });
      await this.inspectRuntime(name, dataVolume(name), {
        approvedImage, approvedImageId, network: desired, container, expectedDockerId: replacement.dockerId,
      });
      if (recovery?.backup) await this.removeRecoveryArtifact(recovery.backup, container);
      // This snapshot was just the canonical container under its previous name;
      // retain stable ownership checks so a repair can remove security drift.
      await this.removeCanonicalSnapshot(displaced, container, approvedImage);
    } catch (error) {
      if (replacement) await this.removeOwnedCandidate(replacement.dockerId, container, approvedImage, { approvedImageId }).catch(() => {});
      if (recovery?.backup) {
        try {
          const backup = await this.revalidateRecoveryArtifact(recovery.backup, container);
          await this.docker(['rename', backup.dockerId, name]);
          await this.inspectRuntime(name, dataVolume(name), {
            approvedImage,
            network: backup.network,
            allowControllerEndpointDrift: true,
            allowRecoveredDigest: true,
            container,
            expectedDockerId: backup.dockerId,
          });
          await this.removeCanonicalSnapshot(displaced, container, approvedImage);
        } catch (rollbackError) {
          await this.docker(['rename', canonical.dockerId, name]).catch(() => {});
          throw rollbackError;
        }
      } else {
        await this.docker(['rename', canonical.dockerId, name]).catch(() => {});
        if (wasRunning) await this.docker(['start', canonical.dockerId]).catch(() => {});
      }
      throw error;
    }
    const staleNetworks = Object.keys(actual).filter((network) => isManagedNetwork(network) && !managedNetworkNames(desired).includes(network));
    for (const network of staleNetworks) await this.removeManagedNetwork(network);
    return desired;
  }

  async recoverInterruptedBackup(container) {
    const name = dockerName(container);
    const backupName = networkBackupName(name);
    const holdName = networkRecoveryHoldName(name);
    const backupExists = await this.namedContainerExists(backupName);
    const holdExists = await this.namedContainerExists(holdName);
    if (!backupExists && !holdExists) return null;

    let primaryExists = true;
    try {
      await this.inspectContainer(name);
    } catch (error) {
      if (!isMissingDockerObject(error, name)) throw error;
      primaryExists = false;
    }

    const backup = backupExists ? await this.captureRecoveryArtifact(backupName, container) : null;
    const hold = holdExists ? await this.captureRecoveryArtifact(holdName, container) : null;

    if (primaryExists) return { backup, hold };
    const restore = backup || hold;
    await this.docker(['rename', restore.dockerId, name]);
    await this.inspectRuntime(name, dataVolume(name), {
      approvedImage: this.approvedImage(container),
      network: restore.network,
      allowControllerEndpointDrift: true,
      allowRecoveredDigest: true,
      container,
      expectedDockerId: restore.dockerId,
    });
    if (backup && hold) await this.removeRecoveryArtifact(hold, container);
    return null;
  }

  async namedContainerExists(name) {
    const listed = await this.docker(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']);
    return String(listed.stdout || '').split(/\r?\n/).includes(name);
  }

  async cleanupRecoveryArtifacts(recovery, container) {
    if (!recovery) return;
    // Validate the whole recovery set before any deletion. Each Docker ID then
    // stays immutable through cleanup even if its deterministic name is reused.
    const artifacts = [recovery.backup, recovery.hold].filter(Boolean);
    const validated = [];
    for (const artifact of artifacts) validated.push(await this.revalidateRecoveryArtifact(artifact, container));
    for (const artifact of validated) await this.docker(['rm', '-f', artifact.dockerId]);
  }

  async inspectCanonicalOwnership(name, container, approvedImage, { expectedDockerId = null, volumeName = name, approvedImageId = null, allowRecoveredDigest = false } = {}) {
    return this.inspectContainerOwnership(name, container, approvedImage, { expectedDockerId, volumeName, approvedImageId, allowRecoveredDigest });
  }

  async inspectOwnedCandidate(dockerId, container, approvedImage, { volumeName = dockerName(container), approvedImageId = null, allowRecoveredDigest = false } = {}) {
    return this.inspectContainerOwnership(dockerId, container, approvedImage, { expectedDockerId: dockerId, volumeName, approvedImageId, allowRecoveredDigest });
  }

  async inspectContainerOwnership(target, container, approvedImage, { expectedDockerId = null, volumeName = dockerName(container), approvedImageId = null, allowRecoveredDigest = false } = {}) {
    const inspection = await this.inspectContainer(target);
    const config = inspection.Config || {};
    const labels = config.Labels || {};
    const binds = Array.isArray(inspection.HostConfig?.Binds) ? inspection.HostConfig.Binds : [];
    const dockerId = dockerObjectId(inspection.Id);
    const persistedName = safeLabel(labels[MANAGED_CONTAINER_NAME_LABEL]);
    const persistedDeviceId = safeLabel(labels['war-device-id']);
    const expectedName = container.name ? safeLabel(container.name) : persistedName;
    const expectedDeviceId = container.deviceId ? safeLabel(container.deviceId) : persistedDeviceId;
    const trusted = labels['managed-by'] === MANAGED_LABEL
      && labels[MANAGED_CONTAINER_ID_LABEL] === safeLabel(container.id)
      && labels[MANAGED_CONTAINER_NAME_LABEL] === expectedName
      && labels['war-device-id'] === expectedDeviceId
      && matchesApprovedImage(config.Image, inspection.Image, approvedImage, approvedImageId, { allowRecoveredDigest })
      && binds.includes(`${dataVolume(volumeName)}:/data`)
      && (!expectedDockerId || dockerId === expectedDockerId);
    if (!trusted) throw new Error('Managed container ownership policy failed');
    return {
      name: target,
      dockerId,
      running: inspection.State?.Running,
      networkNames: Object.keys(inspection.NetworkSettings?.Networks || {}),
      ipv4MacAddress: ipv4MacAddressFromInspection(inspection),
    };
  }

  async captureRecoveryArtifact(name, container, { expectedDockerId = null, network: expectedNetwork = null } = {}) {
    try {
      const inspection = await this.inspectContainer(name);
      const dockerId = dockerObjectId(inspection.Id);
      if (expectedDockerId && dockerId !== expectedDockerId) throw recoveryArtifactUntrusted();
      const network = expectedNetwork || (inspection.State?.Running === false
        ? this.networkFromRuntime(container.runtime)
        : runtimeNetworkFromInspection(inspection, this.config));
      await this.inspectRuntime(name, dataVolume(dockerName(container)), {
        approvedImage: this.approvedImage(container),
        network,
        allowControllerEndpointDrift: true,
        allowRecoveredDigest: true,
        container,
        expectedDockerId: dockerId,
      });
      return { name, dockerId, network };
    } catch (error) {
      if (error?.code === 'RECOVERY_ARTIFACT_UNTRUSTED') throw error;
      throw recoveryArtifactUntrusted();
    }
  }

  async revalidateRecoveryArtifact(artifact, container) {
    if (!artifact?.name || !artifact?.dockerId) throw recoveryArtifactUntrusted();
    return this.captureRecoveryArtifact(artifact.name, container, {
      expectedDockerId: artifact.dockerId,
      network: artifact.network,
    });
  }

  async removeRecoveryArtifact(artifact, container) {
    const validated = await this.revalidateRecoveryArtifact(artifact, container);
    await this.docker(['rm', '-f', validated.dockerId]);
  }

  async removeCanonicalSnapshot(snapshot, container, approvedImage) {
    try {
      const validated = await this.inspectCanonicalOwnership(snapshot.name, container, approvedImage, {
        expectedDockerId: snapshot.dockerId,
        volumeName: snapshot.canonicalName,
        allowRecoveredDigest: true,
      });
      await this.docker(['rm', '-f', validated.dockerId]);
    } catch (error) {
      if (error?.code === 'RECOVERY_ARTIFACT_UNTRUSTED') throw error;
      throw recoveryArtifactUntrusted();
    }
  }

  async removeOwnedCandidate(dockerId, container, approvedImage, { approvedImageId = null } = {}) {
    try {
      const candidate = await this.inspectOwnedCandidate(dockerId, container, approvedImage, { approvedImageId });
      await this.docker(['rm', '-f', candidate.dockerId]);
    } catch (error) {
      if (error?.code === 'RECOVERY_ARTIFACT_UNTRUSTED') throw error;
      throw recoveryArtifactUntrusted();
    }
  }

  async waitForIpv6Endpoint(name, network, { expectedDockerId = null } = {}) {
    if (!network.ipv6Enabled || network.ipv6Driver !== 'macvlan') return;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const inspection = await this.inspectContainer(name);
      if (expectedDockerId && dockerObjectId(inspection.Id) !== expectedDockerId) {
        throw new Error('Managed container Docker ID changed while waiting for IPv6');
      }
      const actual = inspection.NetworkSettings?.Networks?.[network.ipv6Network];
      if (matchesIpv6Endpoint(actual, network.ipv6Address)) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Managed macvlan container did not receive the expected IPv6 SLAAC address');
  }

  async scanManagedContainers() {
    const listed = await this.docker(['ps', '-a', '--filter', `label=managed-by=${MANAGED_LABEL}`, '--format', '{{.Names}}']);
    const names = [...new Set(String(listed.stdout || '').split(/\r?\n/).map((value) => value.trim()).filter((value) => NAME_PATTERN.test(value)))];
    const approvedImage = this.approvedImage();
    const approvedImageId = await this.imageId(approvedImage);
    const containers = [];
    const rejected = [];
    for (const name of names) {
      try {
        const inspection = await this.inspectContainer(name);
        if (inspection.Config?.Labels?.['managed-by'] !== MANAGED_LABEL) throw new Error('managed label missing');
        const network = runtimeNetworkFromInspection(inspection, this.config);
        const runtime = await this.inspectRuntime(name, dataVolume(name), {
          approvedImage,
          approvedImageId,
          network,
          allowStoppedIpv4MacDiscoveryGap: true,
        });
        const env = parseEnvironment(inspection.Config?.Env);
        const labels = inspection.Config?.Labels || {};
        const credential = await this.readCredential(name, dataVolume(name), approvedImageId);
        const deviceId = safeIdentifier(labels['war-device-id'] || env.WAR_MANAGED_DEVICE_ID);
        if (!deviceId || !credential) throw new Error('managed identity credential is unavailable');
        containers.push({
          containerId: safeIdentifier(labels[MANAGED_CONTAINER_ID_LABEL]),
          name: safeContainerName(labels[MANAGED_CONTAINER_NAME_LABEL] || name),
          dockerName: name,
          deviceId,
          credential,
          image: approvedImage,
          host: this.config.hostId || null,
          runtime,
          status: mapDockerStatus(inspection.State?.Status),
        });
      } catch (error) {
        rejected.push({ dockerName: name, reason: String(error?.message || 'invalid managed container').slice(0, 160) });
      }
    }
    return { containers, rejected };
  }

  async readCredential(name, volume, approvedImage = this.approvedImage()) {
    const result = await this.docker([
      'run', '--rm', ...this.helperContainerArgs(), '--user', 'war',
      '-v', `${volume}:/data:ro`, '--entrypoint', '/bin/sh', approvedImage,
      '-c', `umask 077; cat ${CREDENTIAL_PATH}`,
    ]);
    const credential = String(result.stdout || '').trim();
    return /^[A-Za-z0-9_-]{24,256}$/.test(credential) ? credential : null;
  }

  async ensureManagedDataVolume(name, container) {
    try {
      return { ...await this.inspectManagedDataVolume(name, container), created: false };
    } catch (error) {
      if (!isMissingDockerVolume(error, name)) throw error;
    }
    await this.docker([
      'volume', 'create',
      '--label', `managed-by=${MANAGED_LABEL}`,
      '--label', `${MANAGED_CONTAINER_ID_LABEL}=${safeLabel(container.id)}`,
      '--label', `${MANAGED_CONTAINER_NAME_LABEL}=${safeLabel(container.name)}`,
      '--label', `war-device-id=${safeLabel(container.deviceId)}`,
      '--label', 'war-data-volume=true',
      name,
    ]);
    return { ...await this.inspectManagedDataVolume(name, container), created: true };
  }

  async inspectManagedDataVolume(name, container, { expectedSnapshot = null } = {}) {
    const result = await this.docker(['volume', 'inspect', '--format', '{{json .}}', name]);
    let inspection;
    try { inspection = JSON.parse(result.stdout.trim()); } catch { throw new Error('Managed data volume inspect response is invalid'); }
    const labels = inspection?.Labels || {};
    const trusted = inspection?.Name === name
      && labels['managed-by'] === MANAGED_LABEL
      && labels[MANAGED_CONTAINER_ID_LABEL] === safeLabel(container.id)
      && labels[MANAGED_CONTAINER_NAME_LABEL] === safeLabel(container.name)
      && labels['war-device-id'] === safeLabel(container.deviceId)
      && labels['war-data-volume'] === 'true';
    if (!trusted) throw new Error('Managed data volume ownership policy failed');
    const snapshot = volumeSnapshot(inspection);
    if (expectedSnapshot && !sameVolumeSnapshot(snapshot, expectedSnapshot)) {
      throw new Error('Managed data volume changed before cleanup');
    }
    return { name, snapshot };
  }

  async inspectLegacyDataVolume(name) {
    const result = await this.docker(['volume', 'inspect', '--format', '{{json .}}', name]);
    let inspection;
    try { inspection = JSON.parse(result.stdout.trim()); } catch { return null; }
    const labels = inspection?.Labels || {};
    if (inspection?.Name !== name || Object.keys(labels).length !== 0) return null;
    return { name };
  }

  async removeManagedDataVolume(volume) {
    if (!volume?.name || !volume?.snapshot) throw new Error('Managed data volume snapshot is required');
    const revalidated = await this.inspectManagedDataVolume(volume.name, {
      id: volume.snapshot.Labels?.[MANAGED_CONTAINER_ID_LABEL],
      name: volume.snapshot.Labels?.[MANAGED_CONTAINER_NAME_LABEL],
      deviceId: volume.snapshot.Labels?.['war-device-id'],
    }, { expectedSnapshot: volume.snapshot });
    await this.docker(['volume', 'rm', revalidated.name]);
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

  async captureManagedNetwork(name, { expectedDockerId = null } = {}) {
    if (!isManagedNetwork(name)) throw new Error('Managed network name is invalid');
    const result = await this.docker(['network', 'inspect', '--format', '{{json .}}', name]);
    let inspection;
    try { inspection = JSON.parse(result.stdout.trim()); } catch { throw new Error('Managed network inspect response is invalid'); }
    const dockerId = dockerObjectId(inspection?.Id);
    if (!this.matchesNetworkCapability(inspection, name) || (expectedDockerId && dockerId !== expectedDockerId)) {
      throw new Error('Managed network ownership policy failed');
    }
    return { name, dockerId };
  }

  async removeManagedNetwork(artifactOrName) {
    let artifact = artifactOrName;
    if (typeof artifactOrName === 'string') {
      try {
        artifact = await this.captureManagedNetwork(artifactOrName);
      } catch (error) {
        if (isMissingDockerNetwork(error, artifactOrName)) return;
        if (await this.inspectLegacyManagedNetwork(artifactOrName)) return false;
        throw error;
      }
    }
    const validated = await this.captureManagedNetwork(artifact?.name, { expectedDockerId: artifact?.dockerId });
    const finalInspection = await this.inspectManagedNetwork(validated.dockerId);
    if (dockerObjectId(finalInspection?.Id) !== validated.dockerId || !this.matchesNetworkCapability(finalInspection, validated.name)) {
      throw new Error('Managed network ownership policy failed');
    }
    if (Object.keys(finalInspection.Containers || {}).length > 0) return false;
    await this.docker(['network', 'rm', validated.dockerId]);
    return true;
  }

  async inspectManagedNetwork(target) {
    const result = await this.docker(['network', 'inspect', '--format', '{{json .}}', target]);
    try { return JSON.parse(result.stdout.trim()); } catch { throw new Error('Managed network inspect response is invalid'); }
  }

  async inspectLegacyManagedNetwork(name) {
    try {
      const inspection = await this.inspectManagedNetwork(name);
      return this.matchesLegacyNetwork(inspection, name) && !this.matchesNetworkCapability(inspection, name)
        ? { name, dockerId: dockerObjectId(inspection.Id) }
        : null;
    } catch {
      return null;
    }
  }

  async inspectRuntime(name, volume, { approvedImage, approvedImageId, network = this.networkFromRuntime({}), allowControllerEndpointDrift = false, allowRecoveredDigest = false, allowStoppedIpv4MacDiscoveryGap = false, container = null, expectedDockerId = null } = {}) {
    const resolvedApprovedImageId = approvedImage
      ? (approvedImageId || await this.imageId(approvedImage))
      : null;
    const imageEnvironment = resolvedApprovedImageId
      ? await this.imageEnvironment(resolvedApprovedImageId)
      : null;
    const inspection = await this.inspectContainer(name);
    const host = inspection.HostConfig || {};
    const config = inspection.Config || {};
    const stopped = inspection.State?.Running === false;
    const actualNetworks = inspection.NetworkSettings?.Networks || {};
    const measuredIpv4MacAddress = network.ipv4Enabled && network.ipv4Network !== 'bridge'
      ? normalizeOptionalIpv4MacAddress(actualNetworks[network.ipv4Network]?.MacAddress)
      : null;
    const ipv4MacAddress = measuredIpv4MacAddress || network.ipv4MacAddress;
    const actualNetworkNames = Object.keys(actualNetworks);
    const binds = Array.isArray(host.Binds) ? host.Binds : [];
    const securityOptions = Array.isArray(host.SecurityOpt) ? host.SecurityOpt : [];
    const portBindings = host.PortBindings;
    const expectedWssUrl = this.controllerWssUrl();
    const environment = parseEnvironment(config.Env);
    const expectedRuntimeEnvironment = imageEnvironment
      ? this.expectedRuntimeEnvironment({ config, environment, container, imageEnvironment, expectedWssUrl, allowControllerEndpointDrift })
      : null;
    const safe = config.User === 'war'
      && host.Privileged === false
      && hasExactlyAllCapabilities(host.CapDrop)
      && hasNoCapabilitiesAdded(host.CapAdd)
      && hasNoDeviceAccess(host)
      && hasNoHostNamespaces(host)
      && hasExpectedMounts(inspection.Mounts, volume, this.config.controllerCaPath)
      && host.NetworkMode !== 'host'
      && actualNetworkNames.length > 0
      && actualNetworkNames.every((name) => name === network.ipv4Network || name === 'bridge' || name === network.ipv6Network)
      && Boolean(actualNetworks[network.ipv4Network]) === network.ipv4Enabled
      // Docker clears assigned addresses after stop; keep validating membership and
      // security while allowing a stopped container to have no live endpoint.
      && (!network.ipv4Enabled || network.ipv4Network === 'bridge' || actualNetworks[network.ipv4Network]?.IPAddress || stopped)
      && (!network.ipv4Enabled
        || network.ipv4Network === 'bridge'
        || matchesIpv4EndpointMacAddress(actualNetworks[network.ipv4Network], network.ipv4MacAddress, { stopped })
        || (allowStoppedIpv4MacDiscoveryGap && stopped && !measuredIpv4MacAddress && !network.ipv4MacAddress))
      && (!network.ipv6Enabled || matchesIpv6Endpoint(actualNetworks[network.ipv6Network], network.ipv6Address) || stopped)
      && (!network.ipv6Enabled || actualNetworks[network.ipv6Network]?.GlobalIPv6PrefixLen === 64 || stopped)
      && hasApprovedSecurityOptions(securityOptions)
      && host.Memory === 2 * 1024 * 1024 * 1024
      && host.NanoCpus === 2_000_000_000
      && host.PidsLimit === 512
      && binds.some((bind) => bind === `${volume}:/data`)
      && binds.every((bind) => safeBind(bind, volume, this.config.controllerCaPath))
      && hasNoPublishedPorts(portBindings)
      && config.Labels?.['managed-by'] === MANAGED_LABEL
      && (!container?.id || config.Labels?.[MANAGED_CONTAINER_ID_LABEL] === safeLabel(container.id))
      && (!container?.name || config.Labels?.[MANAGED_CONTAINER_NAME_LABEL] === safeLabel(container.name))
      && (!container?.deviceId || config.Labels?.['war-device-id'] === safeLabel(container.deviceId))
      && matchesRuntimeEnvironment(environment, expectedRuntimeEnvironment)
      && (allowControllerEndpointDrift || !expectedWssUrl || environment.WAR_CONTROLLER_WSS_URL === expectedWssUrl)
      && (!approvedImage || matchesApprovedImage(config.Image, inspection.Image, approvedImage, resolvedApprovedImageId, { allowRecoveredDigest }))
      && (!expectedDockerId || inspection.Id === expectedDockerId);
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
      host: this.config.hostLabel,
      ipv4Enabled: network.ipv4Enabled,
      ipv4Network: network.ipv4Network === 'bridge' ? null : network.ipv4Network,
      ipv4MacAddress,
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

  expectedRuntimeEnvironment({ config, environment, container, imageEnvironment, expectedWssUrl, allowControllerEndpointDrift }) {
    const labelDeviceId = safeIdentifier(config.Labels?.['war-device-id']);
    const deviceId = container?.deviceId || labelDeviceId;
    if (!safeIdentifier(deviceId)) return null;
    const entries = this.environment({ deviceId }).entries;
    if (allowControllerEndpointDrift && expectedWssUrl) {
      const actualWssUrl = environment?.WAR_CONTROLLER_WSS_URL;
      if (!isRecoverableControllerWssUrl(actualWssUrl)) return null;
      const index = entries.findIndex(([key]) => key === 'WAR_CONTROLLER_WSS_URL');
      if (index < 0) return null;
      entries[index] = ['WAR_CONTROLLER_WSS_URL', actualWssUrl];
    }
    return runtimeEnvironmentBaseline(imageEnvironment, entries);
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
      '--',
      this.config.sshTarget,
      command,
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
  // Versioning prevents new containers from attaching to pre-capability shared
  // IPv6 networks while allowing an owned legacy container to migrate safely.
  const hash = crypto.createHash('sha256').update(`${MANAGED_NETWORK_VERSION}:${driver}:${normalizeIpv6Prefix(prefix)}`).digest('hex').slice(0, 12);
  return `${MANAGED_IPV6_NETWORK_PREFIX}${hash}`;
}

function managedIpv4NetworkName(containerName) {
  const hash = crypto.createHash('sha256').update(String(containerName)).digest('hex').slice(0, 12);
  return `${MANAGED_IPV4_NETWORK_PREFIX}${hash}`;
}

function attachedLegacyIpv6Network({ runtime, canonicalIpv6Network, discoveryPrefix, driver, expectedAddress, attachedNetworks }) {
  const name = String(runtime?.ipv6Network || '');
  if (name === canonicalIpv6Network || !isManagedIpv6Network(name) || !attachedNetworks.has(name)) return null;
  try {
    return runtime.ipv6Driver === driver
      && normalizeIpv6Prefix(runtime.ipv6Prefix) === discoveryPrefix
      && normalizeIpv6Address(runtime.ipv6Address) === expectedAddress
      ? name
      : null;
  } catch {
    return null;
  }
}

function attachedLegacyIpv4Network({ runtime, canonicalIpv4Network, attachedNetworks, canonicalDockerId }) {
  // Legacy IPv4 names are deterministic, but only reconcile can prove the
  // persisted network remains attached to the authenticated container ID.
  return runtime?.ipv4Enabled === true
    && runtime?.ipv4Network === canonicalIpv4Network
    && attachedNetworks?.has(canonicalIpv4Network)
    && isCanonicalDockerId(canonicalDockerId)
    ? canonicalIpv4Network
    : null;
}

function hasExactLabels(labels, expected) {
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return false;
  const entries = Object.entries(labels);
  return entries.length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => labels[key] === value);
}

function hasValidIpv4Ipam(ipam) {
  const configs = ipam?.Config;
  if (!Array.isArray(configs) || configs.length !== 1) return false;
  const config = configs[0];
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  const subnet = parseIpv4Cidr(config.Subnet);
  if (!subnet) return false;
  if (config.Gateway != null && !isIpv4AddressInCidr(config.Gateway, subnet)) return false;
  if (config.IPRange != null) {
    const ipRange = parseIpv4Cidr(config.IPRange);
    if (!ipRange || !isIpv4CidrWithin(ipRange, subnet)) return false;
  }
  if (config.AuxiliaryAddresses != null) {
    if (!config.AuxiliaryAddresses || typeof config.AuxiliaryAddresses !== 'object' || Array.isArray(config.AuxiliaryAddresses)) return false;
    if (!Object.values(config.AuxiliaryAddresses).every((address) => isIpv4AddressInCidr(address, subnet))) return false;
  }
  return true;
}

function isCanonicalEndpoint(endpoint, subnet) {
  const cidr = parseIpv4Cidr(subnet);
  return endpoint
    && typeof endpoint === 'object'
    && !Array.isArray(endpoint)
    && isCanonicalDockerId(endpoint.EndpointID)
    && typeof endpoint.IPv4Address === 'string'
    && cidr
    && isIpv4AddressInCidr(endpoint.IPv4Address, cidr)
    && endpoint.IPv6Address === '';
}

function parseIpv4Cidr(value) {
  const [address, prefixLength, ...extra] = String(value || '').trim().split('/');
  if (extra.length || !/^\d{1,2}$/.test(prefixLength || '')) return null;
  const prefix = Number(prefixLength);
  const numericAddress = parseIpv4Address(address);
  if (numericAddress == null || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  if (((numericAddress & mask) >>> 0) !== numericAddress) return null;
  return { address: numericAddress, prefix, mask };
}

function parseIpv4Address(value) {
  const groups = String(value || '').trim().split('.');
  if (groups.length !== 4 || groups.some((group) => !/^(?:0|[1-9]\d{0,2})$/.test(group))) return null;
  const bytes = groups.map(Number);
  if (bytes.some((byte) => byte > 255)) return null;
  return (((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3]) >>> 0;
}

function isIpv4AddressInCidr(value, cidr) {
  const address = String(value || '').trim().split('/');
  if (address.length > 2 || (address.length === 2 && !/^\d{1,2}$/.test(address[1]))) return false;
  const numericAddress = parseIpv4Address(address[0]);
  const prefix = address.length === 2 ? Number(address[1]) : null;
  return numericAddress != null
    && (prefix == null || prefix === cidr.prefix)
    && ((numericAddress & cidr.mask) >>> 0) === cidr.address;
}

function isIpv4CidrWithin(inner, outer) {
  return inner.prefix >= outer.prefix && ((inner.address & outer.mask) >>> 0) === outer.address;
}

function isCanonicalDockerId(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || '').trim());
}

function networkBackupName(containerName) {
  const hash = crypto.createHash('sha256').update(`backup:${containerName}`).digest('hex').slice(0, 8);
  return `${String(containerName).slice(0, 55)}-network-backup-${hash}`;
}

function networkRecoveryHoldName(containerName) {
  const hash = crypto.createHash('sha256').update(`recovery-hold:${containerName}`).digest('hex').slice(0, 8);
  return `${String(containerName).slice(0, 52)}-recovery-hold-${hash}`;
}

function isMissingDockerObject(error, targetName) {
  if (!NAME_PATTERN.test(String(targetName || ''))) return false;
  const escapedName = String(targetName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exact = new RegExp(`^(?:(?:Error response from daemon|Error):\\s*)?No such (?:container|object):\\s*${escapedName}$`, 'i');
  return `${error?.stderr || ''}\n${error?.message || ''}`
    .split(/\r?\n/)
    .some((line) => exact.test(line.trim()));
}

function isMissingDockerVolume(error, targetName) {
  if (!VOLUME_NAME_PATTERN.test(String(targetName || ''))) return false;
  const escapedName = String(targetName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exact = new RegExp(`^(?:(?:Error response from daemon|Error):\\s*)?No such volume:\\s*${escapedName}$`, 'i');
  return `${error?.stderr || ''}\n${error?.message || ''}`
    .split(/\r?\n/)
    .map((value) => value.trim())
    .some((value) => exact.test(value));
}

function isMissingDockerNetwork(error, targetName) {
  if (!NAME_PATTERN.test(String(targetName || ''))) return false;
  const escapedName = String(targetName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exact = new RegExp(`^(?:(?:Error response from daemon|Error):\\s*)?No such network:\\s*${escapedName}$`, 'i');
  return `${error?.stderr || ''}\n${error?.message || ''}`
    .split(/\r?\n/)
    .map((value) => value.trim())
    .some((value) => exact.test(value));
}

function volumeSnapshot(inspection) {
  return {
    Name: inspection.Name,
    CreatedAt: inspection.CreatedAt ?? null,
    Driver: inspection.Driver ?? null,
    Mountpoint: inspection.Mountpoint ?? null,
    Labels: inspection.Labels || {},
    Options: inspection.Options || {},
    Scope: inspection.Scope ?? null,
  };
}

function sameVolumeSnapshot(left, right) {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function dockerObjectId(value) {
  const id = String(value || '').trim();
  // Docker inspect supplies the full immutable ID. Reject absent or control-bearing
  // values so recovery never falls back to a mutable deterministic name.
  if (!/^[a-f0-9]{64}$/i.test(id)) throw recoveryArtifactUntrusted();
  return id;
}

function matchesApprovedImage(configImage, inspectedImage, approvedTag, approvedImageId = null, { allowRecoveredDigest = false } = {}) {
  if (typeof approvedTag !== 'string' || !approvedTag) return false;
  const configured = String(configImage || '');
  if (allowRecoveredDigest && /^sha256:[a-f0-9]{64}$/i.test(configured) && configured === inspectedImage) return true;
  if (approvedImageId) {
    return inspectedImage === approvedImageId && (configured === approvedTag || configured === approvedImageId);
  }
  // Legacy callers still attest a trusted tag; current launch paths provide the
  // resolved ID above and therefore cannot be redirected by a moved tag.
  return configured === approvedTag;
}

function recoveryArtifactUntrusted() {
  const error = new Error('RECOVERY_ARTIFACT_UNTRUSTED');
  error.code = 'RECOVERY_ARTIFACT_UNTRUSTED';
  return error;
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

function networkLabelArgs(labels) {
  return Object.entries({ 'managed-by': MANAGED_LABEL, ...labels })
    .flatMap(([key, value]) => ['--label', `${key}=${value}`]);
}

function containerNetworkArgs(network) {
  const args = [];
  if (network.ipv4Enabled) {
    const options = [`name=${network.ipv4Network}`];
    if (network.ipv4MacAddress) options.push(`mac-address=${network.ipv4MacAddress}`);
    args.push('--network', options.join(','));
  }
  if (network.ipv6Enabled) {
    const options = [`name=${network.ipv6Network}`, `ip6=${network.ipv6Address}`];
    if (network.ipv6MacAddress) options.push(`mac-address=${network.ipv6MacAddress}`);
    args.push('--network', options.join(','));
  }
  return args;
}

function networkMatches(actual, desired, { stopped = false } = {}) {
  const expected = new Set([desired.ipv4Enabled ? desired.ipv4Network : null, desired.ipv6Enabled ? desired.ipv6Network : null].filter(Boolean));
  const names = Object.keys(actual);
  if (names.length !== expected.size || names.some((name) => !expected.has(name))) return false;
  if (desired.ipv4Enabled && desired.ipv4Network !== 'bridge'
    && !matchesIpv4EndpointMacAddress(actual[desired.ipv4Network], desired.ipv4MacAddress, { stopped })) return false;
  if (desired.ipv6Enabled && !matchesIpv6Endpoint(actual[desired.ipv6Network], desired.ipv6Address, { allowConfigured: stopped })) return false;
  if (desired.ipv6Enabled && desired.ipv6Driver === 'macvlan') {
    const liveMacAddress = actual[desired.ipv6Network]?.MacAddress?.toLowerCase();
    if ((!stopped || liveMacAddress) && liveMacAddress !== desired.ipv6MacAddress) return false;
  }
  return true;
}

function ipv4MacAddressFromInspection(inspection) {
  const endpoints = Object.entries(inspection?.NetworkSettings?.Networks || {})
    .filter(([name]) => isManagedIpv4Network(name));
  if (endpoints.length > 1) throw new Error('Managed container IPv4 endpoint is ambiguous');
  return normalizeOptionalIpv4MacAddress(endpoints[0]?.[1]?.MacAddress);
}

function matchesIpv4EndpointMacAddress(network, desiredMacAddress, { stopped = false } = {}) {
  const measuredMacAddress = normalizeOptionalIpv4MacAddress(network?.MacAddress);
  if (measuredMacAddress) return desiredMacAddress ? measuredMacAddress === desiredMacAddress : true;
  return stopped && Boolean(desiredMacAddress);
}

function normalizeOptionalIpv4MacAddress(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).toLowerCase();
  if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(text)
    || (Number.parseInt(text.slice(0, 2), 16) & 1) === 1
    || text === '00:00:00:00:00:00'
    || text === 'ff:ff:ff:ff:ff:ff') {
    throw new Error('Managed container IPv4 MAC address is invalid');
  }
  return text;
}

function isManagedIpv6Network(name) {
  return typeof name === 'string' && name.startsWith(MANAGED_IPV6_NETWORK_PREFIX) && NAME_PATTERN.test(name);
}

function matchesIpv6Endpoint(network, address, { allowConfigured = false } = {}) {
  const candidates = [network?.GlobalIPv6Address, ...(allowConfigured ? [network?.IPAMConfig?.IPv6Address] : [])];
  for (const candidate of candidates) {
    try {
      if (candidate && normalizeIpv6Address(candidate) === address) return true;
    } catch {
      // Keep checking any remaining measured or configured endpoint.
    }
  }
  return false;
}

function mapDockerStatus(status) {
  if (status === 'running') return 'running';
  if (['created', 'restarting'].includes(status)) return 'starting';
  if (['removing', 'dead'].includes(status)) return 'failed';
  return 'stopped';
}

function runtimeNetworkFromInspection(inspection, config) {
  const actual = inspection?.NetworkSettings?.Networks || {};
  const entries = Object.entries(actual);
  const stopped = inspection?.State?.Running === false;
  const ipv4Entry = entries.find(([name, value]) => (isManagedIpv4Network(name) || name === 'bridge') && (Boolean(value?.IPAddress) || stopped));
  const ipv6Entry = entries.find(([name, value]) => isManagedIpv6Network(name) && (Boolean(value?.GlobalIPv6Address) || stopped));
  if (!ipv4Entry && !ipv6Entry) throw new Error('managed container has no usable network endpoint');
  const ipv6AddressValue = ipv6Entry
    ? (ipv6Entry[1].GlobalIPv6Address || (stopped ? ipv6Entry[1].IPAMConfig?.IPv6Address : null))
    : null;
  const ipv6Address = ipv6AddressValue ? normalizeIpv6Address(ipv6AddressValue) : null;
  const ipv4MacAddress = ipv4Entry ? normalizeOptionalIpv4MacAddress(ipv4Entry[1]?.MacAddress) : null;
  const ipv6MacAddress = ipv6Entry?.[1]?.MacAddress ? String(ipv6Entry[1].MacAddress).toLowerCase() : null;
  const ipv6Suffix = ipv6Entry
    ? (ipv6MacAddress ? ipv6Eui64SuffixFromMacAddress(ipv6MacAddress) : ipv6Address.split(':').slice(4).join(':'))
    : null;
  return {
    ipv4Enabled: Boolean(ipv4Entry),
    ipv4Network: ipv4Entry?.[0] || null,
    ipv4MacAddress,
    ipv6Enabled: Boolean(ipv6Entry),
    ipv6Suffix,
    ipv6Driver: ipv6Entry ? (config.ipv6Driver === 'bridge' ? 'bridge' : 'macvlan') : null,
    ipv6MacAddress,
    ipv6Prefix: ipv6Entry ? ipv6PrefixFromAddress(ipv6Address, ipv6Entry[1].GlobalIPv6PrefixLen || 64) : null,
    ipv6Address,
    ipv6Network: ipv6Entry?.[0] || null,
  };
}

function hasExactlyAllCapabilities(capDrop) {
  return Array.isArray(capDrop) && capDrop.length === 1 && capDrop[0] === 'ALL';
}

function hasNoCapabilitiesAdded(capAdd) {
  return capAdd == null || (Array.isArray(capAdd) && capAdd.length === 0);
}

function hasNoDeviceAccess(host) {
  return (host.Devices == null || (Array.isArray(host.Devices) && host.Devices.length === 0))
    && (host.DeviceRequests == null || (Array.isArray(host.DeviceRequests) && host.DeviceRequests.length === 0));
}

function hasNoHostNamespaces(host) {
  return host.PidMode === ''
    && host.IpcMode === 'private'
    && host.UTSMode === ''
    && host.CgroupnsMode === 'private'
    && host.UsernsMode === '';
}

function hasExpectedMounts(mounts, volume, controllerCaPath) {
  if (!Array.isArray(mounts)) return false;
  const expectedCount = controllerCaPath ? 2 : 1;
  if (mounts.length !== expectedCount) return false;
  const dataMount = mounts.find((mount) => mount?.Destination === '/data');
  const caMount = mounts.find((mount) => mount?.Destination === '/run/war/controller-ca.pem');
  return dataMount?.Type === 'volume'
    && dataMount.Name === volume
    && dataMount.RW === true
    && (controllerCaPath
      ? caMount?.Type === 'bind' && caMount.Source === controllerCaPath && caMount.RW === false
      : !caMount);
}

function hasApprovedSecurityOptions(securityOptions) {
  return Array.isArray(securityOptions)
    && securityOptions.length === 2
    && securityOptions.filter((value) => value === 'apparmor=war-browser-agent').length === 1
    && securityOptions.filter((value) => String(value).startsWith('seccomp=')).length === 1
    && matchesApprovedSeccompSecurityOption(securityOptions);
}

function parseEnvironment(entries) {
  if (!Array.isArray(entries)) return null;
  const result = {};
  for (const entry of entries) {
    if (typeof entry !== 'string') return null;
    const separator = entry.indexOf('=');
    if (separator <= 0) return null;
    const key = entry.slice(0, separator);
    if (!/^[A-Z0-9_]{1,80}$/.test(key) || Object.hasOwn(result, key)) return null;
    result[key] = entry.slice(separator + 1);
  }
  return result;
}

function runtimeEnvironmentBaseline(imageEnvironment, runtimeEntries) {
  const expected = new Map(Object.entries(imageEnvironment));
  for (const [key, value] of runtimeEntries) {
    if (expected.has(key)) throw new Error('Approved Docker image environment conflicts with managed runtime environment');
    expected.set(key, value);
  }
  return expected;
}

function matchesRuntimeEnvironment(environment, expectedRuntimeEnvironment) {
  if (!environment) return false;
  if (!expectedRuntimeEnvironment) return false;
  for (const [key, value] of expectedRuntimeEnvironment) {
    if (environment[key] !== value) return false;
  }
  return Object.keys(environment).length === expectedRuntimeEnvironment.size;
}

function isRecoverableControllerWssUrl(value) {
  if (typeof value !== 'string' || value.length > 512 || /[\r\n]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'wss:' || parsed.username || parsed.password || parsed.pathname !== '/v1/agent-session' || parsed.search || parsed.hash) return false;
    return Boolean(normalizeControllerHost(parsed.hostname));
  } catch {
    return false;
  }
}

function safeIdentifier(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(text) ? text : null;
}

function safeContainerName(value) {
  const text = String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
  return text || 'Managed Chromium';
}

function safeLabel(value) {
  const text = String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
  if (!text) throw new Error('Managed container label is invalid');
  return text;
}

function parsePort(value) {
  const match = String(value || '').match(/:(\d+)\s*$/);
  return match ? Number(match[1]) : null;
}

function safeBind(bind, volume, controllerCaPath) {
  if (bind === `${volume}:/data`) return true;
  return Boolean(controllerCaPath && bind === `${controllerCaPath}:/run/war/controller-ca.pem:ro`);
}

function hasNoPublishedPorts(portBindings) {
  return portBindings == null
    || (typeof portBindings === 'object' && !Array.isArray(portBindings) && Object.keys(portBindings).length === 0);
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
