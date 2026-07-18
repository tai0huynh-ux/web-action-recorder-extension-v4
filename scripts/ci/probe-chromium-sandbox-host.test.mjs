import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySandboxCapability } from './probe-chromium-sandbox-host.mjs';

test('classifies an AppArmor user namespace denial before Docker seccomp', () => {
  const result = classifySandboxCapability(evidence({
    host: { appArmorAvailable: true, appArmorRestrictUnprivilegedUserns: 1 },
    namespaces: { user: { ok: false } },
  }));
  assert.equal(result.code, 'HOST_APPARMOR_DENIED');
});

test('classifies Docker seccomp after host user namespaces are available', () => {
  const result = classifySandboxCapability(evidence({
    host: { unprivilegedUsernsClone: 1, maxUserNamespaces: 1024 },
    runtime: { seccompMode: 2 },
    namespaces: { user: { ok: false } },
  }));
  assert.equal(result.code, 'DOCKER_SECCOMP_DENIED');
});

test('classifies no-new-privileges conflict from Chromium evidence', () => {
  const result = classifySandboxCapability(evidence({
    runtime: { noNewPrivileges: true },
    chromium: { signals: { noNewPrivilegesConflict: true } },
  }));
  assert.equal(result.code, 'NO_NEW_PRIVILEGES_CONFLICT');
});

test('classifies an AppArmor transition blocked by no-new-privileges', () => {
  const result = classifySandboxCapability(evidence({
    runtime: { noNewPrivileges: true, appArmorProfile: 'war-browser-agent (enforce)' },
    chromium: { signals: { execDenied: true } },
  }));
  assert.equal(result.code, 'NO_NEW_PRIVILEGES_CONFLICT');
});

test('classifies Chromium namespace denial behind the exact AppArmor profile as seccomp', () => {
  const result = classifySandboxCapability(evidence({
    runtime: { seccompMode: 2, appArmorProfile: 'war-browser-agent (enforce)' },
    namespaces: { user: { ok: false } },
    chromium: { signals: { namespaceFailure: true } },
  }));
  assert.equal(result.code, 'DOCKER_SECCOMP_DENIED');
});

test('accepts the secure user namespace baseline only from authoritative Chromium status', () => {
  const result = classifySandboxCapability(evidence({
    namespaces: Object.fromEntries(['user', 'pid', 'network', 'mount', 'combined'].map((name) => [name, { ok: false }])),
    chromium: {
      started: true,
      signals: {},
      sandboxStatus: { suid: false, userNs: true, pidNs: true, netNs: true, seccompBpf: true, sandboxGood: true },
    },
  }));
  assert.deepEqual(result, {
    code: 'USERNS_SANDBOX_CAPABLE',
    supported: true,
    reason: 'Chromium authoritatively reports user, PID, network, and seccomp-BPF sandbox layers active.',
  });
});

function evidence(overrides = {}) {
  const base = {
    host: {
      containerized: false,
      appArmorAvailable: false,
      appArmorRestrictUnprivilegedUserns: 0,
      unprivilegedUsernsClone: 1,
      maxUserNamespaces: 1024,
    },
    runtime: {
      noNewPrivileges: true,
      seccompMode: 0,
      suidHelper: { present: true, valid: true },
    },
    namespaces: {
      user: { ok: true },
      pid: { ok: true },
      network: { ok: true },
      mount: { ok: true },
      combined: { ok: true },
    },
    chromium: { started: false, forbiddenFlagsPresent: false, signals: {} },
  };
  return {
    ...base,
    ...overrides,
    host: { ...base.host, ...(overrides.host || {}) },
    runtime: { ...base.runtime, ...(overrides.runtime || {}) },
    namespaces: { ...base.namespaces, ...(overrides.namespaces || {}) },
    chromium: { ...base.chromium, ...(overrides.chromium || {}) },
  };
}
