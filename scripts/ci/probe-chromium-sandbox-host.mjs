import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileP = promisify(execFile);
const IMAGE = process.env.WAR_SANDBOX_PROBE_IMAGE || 'war-browser-agent:phase1';
const ARTIFACT = path.resolve('artifacts/container-real-world/sandbox-host-capability.json');
const NAMESPACE_CASES = Object.freeze({
  user: ['--user', '--map-root-user', '/bin/true'],
  pid: ['--user', '--map-root-user', '--pid', '--fork', '/bin/true'],
  network: ['--user', '--map-root-user', '--net', '/bin/true'],
  mount: ['--user', '--map-root-user', '--mount', '/bin/true'],
  combined: ['--user', '--map-root-user', '--pid', '--fork', '--net', '--mount', '/bin/true'],
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  probeChromiumSandboxHost().then((report) => {
    console.log(JSON.stringify(report, null, 2));
  }).catch((error) => {
    console.error(`SANDBOX_HOST_PROBE_ERROR=${safeText(error.message)}`);
    process.exit(1);
  });
}

export async function probeChromiumSandboxHost() {
  const host = await collectHostEvidence();
  const docker = await collectDockerEvidence();
  const runtime = await collectRuntimeEvidence();
  const namespaces = {};
  for (const [name, args] of Object.entries(NAMESPACE_CASES)) {
    namespaces[name] = await runNamespaceCase(args);
  }
  const chromium = await runChromiumCase();
  const evidence = { host, docker, runtime, namespaces, chromium };
  const classification = classifySandboxCapability(evidence);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    host,
    docker,
    runtimePolicy: {
      image: IMAGE,
      user: 'war',
      privileged: false,
      networkMode: 'bridge',
      noNewPrivileges: true,
      seccomp: 'docker-default',
      appArmor: 'war-browser-agent',
      addedCapabilities: [],
      dockerSocketMounted: false,
      hostHomeMounted: false,
    },
    container: { ...runtime, namespaces, chromium },
    classification,
  };
  await fs.mkdir(path.dirname(ARTIFACT), { recursive: true });
  await fs.writeFile(ARTIFACT, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export function classifySandboxCapability(evidence) {
  const { host = {}, runtime = {}, namespaces = {}, chromium = {} } = evidence || {};
  const fail = (code, reason) => ({ code, supported: false, reason });
  if (chromium.forbiddenFlagsPresent) return fail('CHROMIUM_CONFIG_INVALID', 'Forbidden Chromium sandbox flags are configured.');
  if (host.containerized && !namespaces.combined?.ok) return fail('RUNNER_NESTING_UNSUPPORTED', 'The outer runner is containerized and blocks the combined namespace operation.');
  if (host.unprivilegedUsernsClone === 0 || host.maxUserNamespaces === 0) return fail('HOST_USERNS_RESTRICTED', 'Host user namespaces are disabled.');
  if (host.appArmorAvailable && host.appArmorRestrictUnprivilegedUserns === 1 && !namespaces.user?.ok) {
    return fail('HOST_APPARMOR_DENIED', 'Host AppArmor user-namespace restriction blocks the non-root runtime.');
  }
  if (runtime.noNewPrivileges && chromium.signals?.noNewPrivilegesConflict) {
    return fail('NO_NEW_PRIVILEGES_CONFLICT', 'Chromium attempted the SUID helper while no-new-privileges was active.');
  }
  if (!namespaces.user?.ok && runtime.seccompMode === 2 && host.unprivilegedUsernsClone !== 0) {
    return fail('DOCKER_SECCOMP_DENIED', 'Docker seccomp is the remaining measured policy layer for user namespace creation.');
  }
  if (!namespaces.user?.ok && runtime.suidHelper?.present && !runtime.suidHelper.valid) {
    return fail('SUID_HELPER_INVALID', 'The Chromium SUID helper ownership or mode is invalid.');
  }
  if (Object.values(namespaces).every((item) => item?.ok) && chromium.started) {
    return { code: 'USERNS_SANDBOX_CAPABLE', supported: true, reason: 'Required nested namespaces and Chromium startup succeeded under the secure baseline.' };
  }
  return fail('UNKNOWN_NAMESPACE_DENIAL', 'The measured evidence does not isolate the remaining namespace denial.');
}

async function collectHostEvidence() {
  const release = parseOsRelease(await readText('/etc/os-release'));
  return {
    osFamily: release.ID || 'unknown',
    osVersion: release.VERSION_ID || 'unknown',
    kernel: safeText((await command('uname', ['-r'])).stdout),
    architecture: safeText((await command('uname', ['-m'])).stdout),
    containerized: fssync.existsSync('/.dockerenv') || fssync.existsSync('/run/.containerenv'),
    appArmorAvailable: /y/i.test(await readText('/sys/module/apparmor/parameters/enabled')),
    appArmorRestrictUnprivilegedUserns: readInteger('/proc/sys/kernel/apparmor_restrict_unprivileged_userns'),
    unprivilegedUsernsClone: readInteger('/proc/sys/kernel/unprivileged_userns_clone'),
    maxUserNamespaces: readInteger('/proc/sys/user/max_user_namespaces'),
    cgroupVersion: fssync.existsSync('/sys/fs/cgroup/cgroup.controllers') ? 2 : 1,
  };
}

async function collectDockerEvidence() {
  const versionResult = await command('docker', ['version', '--format', '{{json .}}']);
  if (!versionResult.ok) throw new Error('Docker version query failed');
  const version = JSON.parse(versionResult.stdout);
  const securityResult = await command('docker', ['info', '--format', '{{json .SecurityOptions}}']);
  if (!securityResult.ok) throw new Error('Docker security options query failed');
  const options = JSON.parse(securityResult.stdout);
  const allowedSecurityOptions = options.filter((option) => /name=(?:apparmor|seccomp|rootless|cgroupns)/.test(option));
  return {
    clientVersion: safeText(version.Client?.Version),
    serverVersion: safeText(version.Server?.Version),
    serverOs: safeText(version.Server?.Os),
    serverArchitecture: safeText(version.Server?.Arch),
    securityOptions: allowedSecurityOptions,
    rootless: allowedSecurityOptions.some((option) => option.includes('name=rootless')),
  };
}

async function collectRuntimeEvidence() {
  const script = [
    "const fs=require('fs')",
    "const status=fs.readFileSync('/proc/self/status','utf8')",
    "const field=(name)=>status.match(new RegExp('^'+name+':\\\\s+(.*)$','m'))?.[1]?.trim()",
    "const helper=['/usr/lib/chromium/chrome-sandbox','/usr/lib/chromium/chromium-sandbox'].find((item)=>fs.existsSync(item))",
    "const stat=helper?fs.statSync(helper):null",
    "const mode=stat?(stat.mode&0o7777):null",
    "const profile=(()=>{try{return fs.readFileSync('/proc/self/attr/current','utf8').trim()}catch{return 'unavailable'}})()",
    "console.log(JSON.stringify({uid:Number(field('Uid')?.split(/\\s+/)[0]),gid:Number(field('Gid')?.split(/\\s+/)[0]),noNewPrivileges:field('NoNewPrivs')==='1',seccompMode:Number(field('Seccomp')),appArmorProfile:profile,suidHelper:{present:Boolean(helper),path:helper||null,ownerUid:stat?.uid??null,ownerGid:stat?.gid??null,mode:mode===null?null:mode.toString(8),valid:Boolean(stat&&stat.uid===0&&mode===0o4755)},unsharePresent:fs.existsSync('/usr/bin/unshare')}))",
  ].join(';');
  const result = await dockerRun(['--entrypoint', 'node', IMAGE, '-e', script]);
  if (!result.ok) throw new Error('Container runtime metadata probe failed');
  const parsed = JSON.parse(result.stdout);
  return {
    uid: parsed.uid,
    gid: parsed.gid,
    noNewPrivileges: parsed.noNewPrivileges,
    seccompMode: parsed.seccompMode,
    appArmorProfile: safeText(parsed.appArmorProfile),
    suidHelper: parsed.suidHelper,
    unsharePresent: parsed.unsharePresent,
  };
}

async function runNamespaceCase(args) {
  const result = await dockerRun(['--entrypoint', '/usr/bin/unshare', IMAGE, ...args]);
  return {
    ok: result.ok,
    exitCode: result.code,
    signal: failureSignal(result),
  };
}

async function runChromiumCase() {
  const script = 'profile=$(mktemp -d); trap \'rm -rf "$profile"\' EXIT; timeout 20 /usr/bin/chromium --headless=new --disable-gpu --user-data-dir="$profile" --dump-dom about:blank';
  const result = await dockerRun(['--entrypoint', '/bin/sh', IMAGE, '-c', script], 30000);
  const combined = `${result.stdout}\n${result.stderr}`;
  return {
    executable: '/usr/bin/chromium',
    started: result.ok && /<html/i.test(result.stdout),
    exitCode: result.code,
    forbiddenFlagsPresent: /--(?:no-sandbox|disable-sandbox)/.test(script),
    signals: {
      operationNotPermitted: /Operation not permitted|EPERM/i.test(combined),
      namespaceFailure: /namespace/i.test(combined),
      noUsableSandbox: /No usable sandbox/i.test(combined),
      noNewPrivilegesConflict: /no.new.priv|PR_SET_NO_NEW_PRIVS/i.test(combined),
      suidHelperFailure: /setuid sandbox|SUID sandbox/i.test(combined),
    },
  };
}

function dockerRun(extraArgs, timeout = 15000) {
  return command('docker', [
    'run', '--rm',
    '--user', 'war',
    '--security-opt', 'no-new-privileges:true',
    '--security-opt', 'apparmor=war-browser-agent',
    '--network', 'bridge',
    ...extraArgs,
  ], timeout);
}

async function command(file, args, timeout = 10000) {
  try {
    const result = await execFileP(file, args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });
    return { ok: true, code: 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    return {
      ok: false,
      code: Number.isInteger(error.code) ? error.code : null,
      stdout: String(error.stdout || '').slice(-8192).trim(),
      stderr: String(error.stderr || error.message || '').slice(-8192).trim(),
    };
  }
}

function failureSignal(result) {
  const text = `${result.stdout}\n${result.stderr}`;
  if (/Operation not permitted|EPERM/i.test(text)) return 'OPERATION_NOT_PERMITTED';
  if (/not found|ENOENT/i.test(text)) return 'TOOL_UNAVAILABLE';
  if (/timed out|killed/i.test(text)) return 'TIMEOUT';
  return result.ok ? 'NONE' : 'OTHER_FAILURE';
}

function parseOsRelease(text) {
  return Object.fromEntries(String(text).split(/\r?\n/).map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((match) => [match[1], match[2].replace(/^['"]|['"]$/g, '')]));
}

function readInteger(file) {
  try {
    const value = Number(fssync.readFileSync(file, 'utf8').trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function readText(file) {
  try {
    return (await fs.readFile(file, 'utf8')).trim();
  } catch {
    return '';
  }
}

function safeText(value) {
  return String(value || '').replace(/[\r\n\t]/g, ' ').slice(0, 200);
}
