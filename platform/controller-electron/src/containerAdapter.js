import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_IMAGE = 'war-browser-agent:phase1';
const CONTROL_PORT = '3766';
const MANAGED_LABEL = 'war-controller';
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

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

  async create(container) {
    const name = dockerName(container);
    const volume = dataVolume(name);
    await this.docker(['volume', 'create', volume]);
    try {
      const environment = this.environment(container);
      await this.dockerRun([
        'run', '-d',
        '--name', name,
        '--label', `managed-by=${MANAGED_LABEL}`,
        '--restart', 'unless-stopped',
        '-p', `127.0.0.1::${CONTROL_PORT}`,
        '-v', `${volume}:/data`,
        '--add-host', 'host.docker.internal:host-gateway',
        ...environment.mountArgs,
        image(container),
      ], environment.entries);
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
    await this.docker(['rm', '-f', name]);
    await this.docker(['volume', 'rm', '-f', dataVolume(name)]);
    return { status: 'deleted', runtime: { dockerName: name } };
  }

  environment(container) {
    const entries = [
      ['WAR_MANAGED_DEVICE_ID', container.deviceId],
      ['WAR_CONTROLLER_SESSION_CREDENTIAL', container.provisioning?.credential],
      ['WAR_CONTROLLER_WSS_URL', this.controllerWssUrl()],
      ['WAR_BROWSER_NO_SANDBOX', '1'],
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
      return spawnWithInput(this.spawn, 'ssh', ['-F', 'NUL', this.config.sshTarget, '--', shellJoin(['docker', ...remoteArgs])], {
        input: encodeEnvironment(entries),
        timeoutMs: this.config.timeoutMs,
      });
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
