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

test('accepts the secure user namespace baseline only when all cases pass', () => {
  const result = classifySandboxCapability(evidence({
    namespaces: Object.fromEntries(['user', 'pid', 'network', 'mount', 'combined'].map((name) => [name, { ok: true }])),
    chromium: { started: true, signals: {} },
  }));
  assert.deepEqual(result, {
    code: 'USERNS_SANDBOX_CAPABLE',
    supported: true,
    reason: 'Required nested namespaces and Chromium startup succeeded under the secure baseline.',
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
