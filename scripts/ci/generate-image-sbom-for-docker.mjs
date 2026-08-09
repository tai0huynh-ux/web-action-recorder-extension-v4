import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REVISION_PATTERN = /^[a-f0-9]{40}$/;
const CONTAINER_UID = 1000;
const CONTAINER_GID = 1000;
const CONTAINER_OUTPUT_NAME = '.container-output';
const SBOM_FILE_NAME = 'SBOM.spdx.json';
const BINDING_FILE_NAME = 'SBOM.image-binding.json';
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

export async function generateDockerImageSbom({
  imageId,
  sourceRevision,
  baseRevision = sourceRevision,
  sourceRevisionType = 'git-commit',
  outputDir,
  appArmorProfile = 'war-browser-agent',
  seccompProfile = '/etc/war/security/chromium-userns-seccomp.json',
  docker = runDocker,
  environment = process.env,
} = {}) {
  requirePattern(imageId, IMAGE_ID_PATTERN, 'imageId');
  requirePattern(sourceRevision, REVISION_PATTERN, 'sourceRevision');
  requirePattern(baseRevision, REVISION_PATTERN, 'baseRevision');
  if (!['git-commit', 'working-tree-diff'].includes(sourceRevisionType)) throw new Error('sourceRevisionType is invalid');
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir)) throw new Error('outputDir must be absolute');
  if (outputDir.includes(',') || outputDir.includes('\0')) throw new Error('outputDir contains unsupported Docker mount characters');
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(appArmorProfile)) throw new Error('appArmorProfile is invalid');
  if (!/^\/[A-Za-z0-9._/-]+$/.test(seccompProfile)) throw new Error('seccompProfile is invalid');

  requireSecureLinuxRoot();
  requireTrustedAncestors(path.dirname(outputDir));
  requireLocalDockerEnvironment(environment);
  await requireLocalRootfulDocker(docker);
  const inspectedId = (await docker(['image', 'inspect', imageId, '--format', '{{.Id}}'])).stdout.trim();
  if (inspectedId !== imageId) throw new Error('Docker image ID does not match the requested immutable subject');
  const prepared = prepareOutputDirectory(outputDir);
  const opened = [];
  let published = false;
  try {
    await docker([
      'run', '--rm',
      '--network', 'none',
      '--read-only',
      '--cap-drop', 'ALL',
      '--user', `${CONTAINER_UID}:${CONTAINER_GID}`,
      '--memory', '256m',
      '--cpus', '0.5',
      '--pids-limit', '64',
      '--security-opt', 'no-new-privileges:true',
      '--security-opt', `apparmor=${appArmorProfile}`,
      '--security-opt', `seccomp=${seccompProfile}`,
      '--mount', `type=bind,src=${prepared.containerOutputDir},dst=/out`,
      '--entrypoint', 'node',
      imageId,
      '/usr/local/lib/war/generate-image-sbom.mjs',
      '--source-revision', sourceRevision,
      '--base-revision', baseRevision,
      '--source-revision-type', sourceRevisionType,
      '--image-id', imageId,
      '--output-dir', '/out',
    ]);

    const sbom = openVerifiedArtifact(prepared.files.sbom, 'SBOM');
    opened.push(sbom);
    const bindingArtifact = openVerifiedArtifact(prepared.files.binding, 'SBOM binding');
    opened.push(bindingArtifact);
    const binding = JSON.parse(bindingArtifact.bytes.toString('utf8'));
    if (binding.subject?.imageId !== imageId) throw new Error('Generated SBOM subject does not match the immutable image ID');
    if (binding.sbom?.sha256 !== crypto.createHash('sha256').update(sbom.bytes).digest('hex')) throw new Error('Generated SBOM binding hash mismatch');

    publishArtifacts(prepared, opened);
    published = true;
    return {
      imageId,
      sbomPath: path.join(outputDir, SBOM_FILE_NAME),
      bindingPath: path.join(outputDir, BINDING_FILE_NAME),
      sbomSha256: binding.sbom.sha256,
    };
  } finally {
    for (const artifact of opened) closeQuietly(artifact.fd);
    if (!published) cleanupPreparedOutput(prepared);
  }
}

async function runDocker(args) {
  return execFileAsync('docker', args, { timeout: 5 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
}

function prepareOutputDirectory(outputDir) {
  const prepared = {
    outputDir,
    containerOutputDir: path.join(outputDir, CONTAINER_OUTPUT_NAME),
    files: {},
    createdOutputDir: false,
  };
  try {
    fs.mkdirSync(outputDir, { recursive: false, mode: 0o700 });
    prepared.createdOutputDir = true;
    fs.chownSync(outputDir, 0, 0);
    fs.chmodSync(outputDir, 0o700);
    fs.mkdirSync(prepared.containerOutputDir, { recursive: false, mode: 0o711 });
    fs.chownSync(prepared.containerOutputDir, 0, 0);
    fs.chmodSync(prepared.containerOutputDir, 0o711);
    prepared.files.sbom = createContainerArtifact(prepared.containerOutputDir, SBOM_FILE_NAME);
    prepared.files.binding = createContainerArtifact(prepared.containerOutputDir, BINDING_FILE_NAME);
    return prepared;
  } catch (error) {
    cleanupPreparedOutput(prepared);
    if (error.code === 'EEXIST') throw new Error('SBOM output directory must not already exist');
    throw error;
  }
}

function requireSecureLinuxRoot() {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() !== 0) {
    throw new Error('Secure Docker image SBOM generation requires Linux root');
  }
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) throw new Error('O_NOFOLLOW is required for secure SBOM generation');
}

function requireTrustedAncestors(parentDir) {
  let current = path.resolve(parentDir);
  const root = path.parse(current).root;
  while (true) {
    const real = fs.realpathSync.native(current);
    const stat = fs.lstatSync(current);
    if (real !== current || stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('SBOM output ancestors must be real directories without symlinks');
    const writableByOthers = (stat.mode & 0o022) !== 0;
    const sticky = (stat.mode & 0o1000) !== 0;
    if (stat.uid !== 0 || (writableByOthers && !sticky)) throw new Error('SBOM output ancestor is replaceable by another user');
    if (current === root) break;
    current = path.dirname(current);
  }
}

function requireLocalDockerEnvironment(environment) {
  const dockerHost = String(environment?.DOCKER_HOST || '').trim();
  if (dockerHost && !['unix:///var/run/docker.sock', 'unix:///run/docker.sock'].includes(dockerHost)) {
    throw new Error('Secure SBOM generation requires the local rootful Docker socket');
  }
}

async function requireLocalRootfulDocker(docker) {
  const endpoint = (await docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])).stdout.trim();
  if (!['unix:///var/run/docker.sock', 'unix:///run/docker.sock'].includes(endpoint)) {
    throw new Error('Secure SBOM generation requires a local Docker daemon');
  }
  let securityOptions;
  try {
    securityOptions = JSON.parse((await docker(['info', '--format', '{{json .SecurityOptions}}'])).stdout.trim());
  } catch {
    throw new Error('Docker security options could not be verified');
  }
  if (!Array.isArray(securityOptions)) throw new Error('Docker security options could not be verified');
  if (securityOptions.some((entry) => /(?:^|=)(?:rootless|userns)(?:$|,)/.test(String(entry)))) {
    throw new Error('Secure SBOM generation does not support rootless or userns-remapped Docker');
  }
}

function createContainerArtifact(containerOutputDir, name) {
  const filePath = path.join(containerOutputDir, name);
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(filePath, flags, 0o600);
  try {
    fs.fchownSync(fd, CONTAINER_UID, CONTAINER_GID);
    fs.fchmodSync(fd, 0o600);
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) throw new Error(`Prepared ${name} is not a private regular file`);
    return { name, path: filePath, dev: stat.dev, ino: stat.ino };
  } finally {
    fs.closeSync(fd);
  }
}

function openVerifiedArtifact(expected, label) {
  const fd = fs.openSync(expected.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.dev !== expected.dev || stat.ino !== expected.ino) {
      throw new Error(`${label} artifact identity changed during container generation`);
    }
    if (stat.size <= 0n || stat.size > BigInt(MAX_ARTIFACT_BYTES)) throw new Error(`${label} artifact size is invalid`);
    fs.fchownSync(fd, 0, 0);
    fs.fchmodSync(fd, 0o400);
    return { ...expected, fd, bytes: fs.readFileSync(fd) };
  } catch (error) {
    closeQuietly(fd);
    throw error;
  }
}

function publishArtifacts(prepared, artifacts) {
  for (const artifact of artifacts) {
    const destination = path.join(prepared.outputDir, artifact.name);
    if (fs.existsSync(destination)) throw new Error(`SBOM output already contains ${artifact.name}`);
    fs.fchmodSync(artifact.fd, 0o644);
    fs.renameSync(artifact.path, destination);
  }
  fs.rmdirSync(prepared.containerOutputDir);
  fs.chmodSync(prepared.outputDir, 0o755);
}

function cleanupPreparedOutput(prepared) {
  if (!prepared?.createdOutputDir) return;
  const paths = [
    prepared.files?.sbom?.path,
    prepared.files?.binding?.path,
    path.join(prepared.outputDir, SBOM_FILE_NAME),
    path.join(prepared.outputDir, BINDING_FILE_NAME),
  ].filter(Boolean);
  for (const filePath of paths) {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const directory of [prepared.containerOutputDir, prepared.outputDir]) {
    try {
      fs.rmdirSync(directory);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
    }
  }
}

function closeQuietly(fd) {
  try {
    fs.closeSync(fd);
  } catch (error) {
    if (error.code !== 'EBADF') throw error;
  }
}

function requirePattern(value, pattern, name) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${name} is invalid`);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateDockerImageSbom({
    imageId: requiredEnvironment('WAR_BROWSER_AGENT_IMAGE'),
    sourceRevision: requiredEnvironment('WAR_SOURCE_REVISION'),
    baseRevision: process.env.WAR_BASE_REVISION || process.env.WAR_SOURCE_REVISION,
    sourceRevisionType: process.env.WAR_SOURCE_REVISION_TYPE || 'git-commit',
    outputDir: path.resolve(process.env.WAR_IMAGE_SBOM_OUTPUT_DIR || 'artifacts/container-image-sbom'),
    appArmorProfile: process.env.WAR_BROWSER_AGENT_APPARMOR_PROFILE || 'war-browser-agent',
    seccompProfile: process.env.WAR_BROWSER_AGENT_SECCOMP_PROFILE || '/etc/war/security/chromium-userns-seccomp.json',
  }).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
