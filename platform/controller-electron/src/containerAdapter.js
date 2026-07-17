import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_IMAGE = 'war-browser-agent:phase1';
const CONTROL_PORT = '3766';
const MANAGED_LABEL = 'war-controller';
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

export function createDockerContainerAdapter({ config, execFileImpl = execFileAsync } = {}) {
  const containerConfig = config?.containers;
  if (!containerConfig?.enabled) return null;
  return new DockerContainerAdapter({ config: containerConfig, wss: config?.wss, execFileImpl });
}

export class DockerContainerAdapter {
  constructor({ config, wss, execFileImpl = execFileAsync }) {
    this.config = config;
    this.wss = wss;
    this.execFile = execFileImpl;
  }

  async create(container) {
    const name = dockerName(container);
    const volume = dataVolume(name);
    await this.docker(['volume', 'create', volume]);
    try {
      await this.docker([
        'run', '-d',
        '--name', name,
        '--label', `managed-by=${MANAGED_LABEL}`,
        '--restart', 'unless-stopped',
        '-p', `127.0.0.1::${CONTROL_PORT}`,
        '-v', `${volume}:/data`,
        '--add-host', 'host.docker.internal:host-gateway',
        ...this.environmentArgs(container),
        image(container),
      ]);
    } catch (error) {
      await this.docker(['volume', 'rm', '-f', volume]).catch(() => {});
      throw error;
    }
    return { runtime: await this.runtime(name, volume), status: 'running' };
  }

  async start(container) {
    const name = dockerName(container);
    await this.docker(['start', name]);
    return { runtime: await this.runtime(name, dataVolume(name)), status: 'running' };
  }

  async stop(container) {
    const name = dockerName(container);
    await this.docker(['stop', '--time', '10', name]);
    return { runtime: await this.runtime(name, dataVolume(name)), status: 'stopped' };
  }

  async restart(container) {
    const name = dockerName(container);
    await this.docker(['restart', '--time', '10', name]);
    return { runtime: await this.runtime(name, dataVolume(name)), status: 'running' };
  }

  async status(container) {
    const name = dockerName(container);
    const state = (await this.docker(['inspect', '-f', '{{.State.Status}}', name])).stdout.trim();
    return { status: mapDockerStatus(state), resourceUsage: await this.resourceUsage(name), runtime: await this.runtime(name, dataVolume(name)) };
  }

  async delete(container) {
    const name = dockerName(container);
    await this.docker(['rm', '-f', name]).catch(() => {});
    await this.docker(['volume', 'rm', '-f', dataVolume(name)]).catch(() => {});
    return { status: 'deleted', runtime: { dockerName: name } };
  }

  environmentArgs(container) {
    const env = [
      ['WAR_MANAGED_DEVICE_ID', container.deviceId],
      ['WAR_CONTROLLER_SESSION_CREDENTIAL', container.provisioning?.credential],
      ['WAR_CONTROLLER_WSS_URL', this.controllerWssUrl()],
      ['WAR_BROWSER_NO_SANDBOX', '1'],
    ];
    if (this.config.controllerCaPath) {
      env.push(['NODE_EXTRA_CA_CERTS', '/run/war/controller-ca.pem']);
    }
    const args = [];
    for (const [key, value] of env) {
      if (value) args.push('-e', `${key}=${value}`);
    }
    if (this.config.controllerCaPath) {
      args.push('-v', `${this.config.controllerCaPath}:/run/war/controller-ca.pem:ro`);
    }
    return args;
  }

  controllerWssUrl() {
    if (!this.wss?.enabled) return null;
    const host = this.config.controllerHost || this.wss.host;
    const port = this.wss.port;
    if (!host || !port) return null;
    return `wss://${host}:${port}/v1/agent-session`;
  }

  async runtime(name, volume) {
    const port = await this.docker(['port', name, `${CONTROL_PORT}/tcp`]).catch(() => ({ stdout: '' }));
    return {
      dockerName: name,
      dataVolume: volume,
      networkMode: 'bridge',
      nonRootUser: 'war',
      privileged: false,
      controlPort: parsePort(port.stdout),
      host: this.config.hostLabel,
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

  docker(args) {
    if (this.config.runtime === 'local-docker') {
      return this.execFile('docker', args, { timeout: this.config.timeoutMs });
    }
    if (this.config.runtime === 'ssh-docker') {
      return this.execFile('ssh', ['-F', 'NUL', this.config.sshTarget, '--', shellJoin(['docker', ...args])], { timeout: this.config.timeoutMs });
    }
    throw new Error('Unsupported container runtime');
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

function image(container) {
  const value = container?.image || DEFAULT_IMAGE;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value)) throw new Error('Invalid Docker image');
  return value;
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
