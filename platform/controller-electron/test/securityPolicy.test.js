import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildSecureWebPreferences } from '../src/secureWindow.js';
test('secure preferences are immutable and reject weakening', () => { const p = buildSecureWebPreferences(); assert.equal(p.sandbox, true); assert.equal(p.nodeIntegration, false); assert.throws(() => buildSecureWebPreferences({ nodeIntegration: true })); });

test('AppArmor keeps device identity writable only to the Browser Agent parent', () => {
  const profile = fs.readFileSync(path.resolve('platform/container/security/war-browser-agent.apparmor'), 'utf8');
  const childStart = profile.indexOf('profile cloakbrowser-launcher flags=(attach_disconnected,mediate_deleted)');
  assert.ok(childStart >= 0, 'CloakBrowser launcher child profile is missing');
  const parent = profile.slice(0, childStart);
  const child = profile.slice(childStart);
  assert.doesNotMatch(parent, /^\s*(?:audit\s+)?deny \/data\/device\/\*\*/m, 'parent must retain its device identity access');
  assert.match(child, /^\s*audit deny \/data\/device\/\*\*\s+[^,]+,$/m, 'CloakBrowser launcher child must audit-deny device identity files');
});

test('AppArmor denies the native X11 input socket to the Chromium child only', () => {
  const profile = fs.readFileSync(path.resolve('platform/container/security/war-browser-agent.apparmor'), 'utf8');
  const childStart = profile.indexOf('profile cloakbrowser-launcher flags=(attach_disconnected,mediate_deleted)');
  assert.ok(childStart >= 0, 'CloakBrowser launcher child profile is missing');
  const parent = profile.slice(0, childStart);
  const child = profile.slice(childStart);
  assert.doesNotMatch(parent, /^\s*(?:audit\s+)?deny \/run\/war\/x11-input\.sock\s+/m, 'Browser Agent parent must retain access to its X11 input helper');
  assert.match(child, /^\s*audit deny \/run\/war\/x11-input\.sock rwkl,$/m, 'CloakBrowser launcher child must audit-deny every direct X11 input socket access mode');
});

test('AppArmor keeps clipboard helpers available to the parent but denies Chromium read, map, and execute access', () => {
  const profile = fs.readFileSync(path.resolve('platform/container/security/war-browser-agent.apparmor'), 'utf8');
  const childStart = profile.indexOf('profile cloakbrowser-launcher flags=(attach_disconnected,mediate_deleted)');
  assert.ok(childStart >= 0, 'CloakBrowser launcher child profile is missing');
  const parent = profile.slice(0, childStart);
  const child = profile.slice(childStart);
  for (const helper of ['/usr/bin/xclip', '/usr/local/bin/war-xclip-sensitive']) {
    const escaped = helper.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.doesNotMatch(parent, new RegExp(`^\\s*(?:audit\\s+)?deny ${escaped}\\s+`, 'm'), `Browser Agent parent must retain ${helper}`);
    assert.match(child, new RegExp(`^\\s*audit deny ${escaped}\\s+(?=[^,]*r)(?=[^,]*m)(?=[^,]*x)[^,]+,$`, 'm'), `CloakBrowser launcher child must deny read, map, and every execute mode for ${helper}`);
  }
});

test('AppArmor profile hash is pinned identically by SSH attestation and security validation', () => {
  const profilePath = path.resolve('platform/container/security/war-browser-agent.apparmor');
  const profileHash = crypto.createHash('sha256').update(fs.readFileSync(profilePath)).digest('hex');
  const sshHostManager = fs.readFileSync(path.resolve('platform/controller-electron/src/sshHostManager.js'), 'utf8');
  const validator = fs.readFileSync(path.resolve('scripts/ci/validate-container-security-policy.mjs'), 'utf8');
  const approvedHash = 'b6182de92e8ed7cf31350969042be50352136b3d1e5dccaf6d02aebfbcf2be08';

  assert.equal(profileHash, approvedHash, 'AppArmor policy changed without updating the reviewed hash');
  assert.match(sshHostManager, new RegExp(`APPROVED_APPARMOR_SHA256 = '${approvedHash}'`));
  assert.match(validator, new RegExp(`APPROVED_APPARMOR_SHA256 = '${approvedHash}'`));
});

test('real canary gates accept explicit runtime selections and report the resolved immutable image', () => {
  const sources = {
    containerGate: fs.readFileSync(path.resolve('platform/browser-agent/integration/containerGate.js'), 'utf8'),
    realWorldGate: fs.readFileSync(path.resolve('platform/browser-agent/integration/realWorldContainerGate.js'), 'utf8'),
    sandboxProbe: fs.readFileSync(path.resolve('scripts/ci/probe-chromium-sandbox-host.mjs'), 'utf8'),
  };
  assert.ok(/process\.env\.WAR_BROWSER_AGENT_IMAGE/.test(sources.containerGate), 'container smoke must accept a caller-selected canary image');
  assert.ok(/process\.env\.WAR_BROWSER_AGENT_IMAGE/.test(sources.realWorldGate), 'real-world gate must accept a caller-selected canary image');
  assert.ok(/process\.env\.WAR_BROWSER_AGENT_APPARMOR_PROFILE/.test(sources.realWorldGate), 'real-world gate must accept a caller-selected AppArmor profile');
  assert.ok(/process\.env\.(?:WAR_BROWSER_AGENT|WAR_SANDBOX_PROBE)_IMAGE/.test(sources.sandboxProbe), 'sandbox probe must accept a caller-selected canary image');
  assert.ok(/process\.env\.(?:WAR_BROWSER_AGENT|WAR_SANDBOX_PROBE)_APPARMOR_PROFILE/.test(sources.sandboxProbe), 'sandbox probe must accept a caller-selected AppArmor profile');
  for (const [name, source] of Object.entries(sources)) {
    assert.ok(/imageId\s*:/.test(source), `${name} report must record the resolved image ID`);
    assert.ok(/appArmor\s*:/.test(source), `${name} report must record the selected AppArmor profile`);
    assert.ok(/sha256:/.test(source), `${name} must require a sha256 image ID rather than trust a mutable tag`);
  }
});

test('every Docker canary drops all capabilities and records CapDrop evidence', () => {
  const sources = {
    containerGate: fs.readFileSync(path.resolve('platform/browser-agent/integration/containerGate.js'), 'utf8'),
    realWorldGate: fs.readFileSync(path.resolve('platform/browser-agent/integration/realWorldContainerGate.js'), 'utf8'),
    sandboxProbe: fs.readFileSync(path.resolve('scripts/ci/probe-chromium-sandbox-host.mjs'), 'utf8'),
  };
  for (const [name, source] of Object.entries(sources)) {
    assert.match(source, /'--cap-drop',\s*'ALL'/, `${name} must launch every canary with --cap-drop ALL`);
  }
  assert.match(sources.realWorldGate, /allCapabilitiesDropped\s*:/, 'real-world gate must record exact CapDrop evidence');
  assert.match(sources.realWorldGate, /containerAllCapabilitiesDropped\s*:/, 'real-world gate must make dropped capabilities an acceptance assertion');
});

test('AppArmor isolates browser and native-host children from Agent runtime directories', () => {
  const profile = fs.readFileSync(path.resolve('platform/container/security/war-browser-agent.apparmor'), 'utf8');
  const browserStart = profile.indexOf('profile cloakbrowser-launcher flags=(attach_disconnected,mediate_deleted)');
  const nativeChildStart = profile.indexOf('profile war-native-host flags=(attach_disconnected,mediate_deleted)');
  assert.ok(browserStart >= 0, 'CloakBrowser launcher child profile is missing');
  const browserChild = profile.slice(browserStart, nativeChildStart >= 0 ? nativeChildStart : undefined);

  for (const runtimePath of ['/data/run/', '/data/run/**', '/run/war/', '/run/war/**']) {
    const escaped = runtimePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      browserChild,
      new RegExp(`^\\s*audit deny ${escaped}\\s+(?=[^,]*w)(?=[^,]*k)(?=[^,]*l)[^,]+,$`, 'm'),
      `CloakBrowser launcher child must deny unlink/rebind-relevant access to ${runtimePath}`,
    );
  }
});

test('AppArmor transitions the native host into a dedicated least-privilege child', () => {
  const profile = fs.readFileSync(path.resolve('platform/container/security/war-browser-agent.apparmor'), 'utf8');
  const nativeHostPath = '/usr/local/bin/war-native-host';
  const browserStart = profile.indexOf('profile cloakbrowser-launcher flags=(attach_disconnected,mediate_deleted)');
  const nativeChildStart = profile.indexOf('profile war-native-host flags=(attach_disconnected,mediate_deleted)');
  assert.ok(browserStart >= 0, 'CloakBrowser launcher child profile is missing');
  assert.ok(nativeChildStart > browserStart, 'war-native-host must be a dedicated CloakBrowser-nested AppArmor child profile');
  const browserChild = profile.slice(browserStart, nativeChildStart);
  assert.match(browserChild, new RegExp(`^\\s*${nativeHostPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} Px -> war-browser-agent//cloakbrowser-launcher//war-native-host,$`, 'm'), 'CloakBrowser launcher child must use the directed fully qualified transition for war-native-host');
  const nativeChild = profile.slice(nativeChildStart);

  assert.match(nativeChild, /^\s*\/data\/run\/native-bridge\.sock rw,$/m, 'native-host child must grant the native bridge pathname socket exactly');
  assert.doesNotMatch(nativeChild, /^\s*\/data\/run\/(?:\*|\*\*)\s+[^,]+,$/m, 'native-host child must not grant wildcard Agent runtime access');

  for (const deniedPath of ['/data/device/**', '/run/war/**', '/usr/bin/xclip', '/usr/local/bin/war-xclip-sensitive']) {
    const escaped = deniedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(nativeChild, new RegExp(`^\\s*audit deny ${escaped}\\s+[^,]+,$`, 'm'), `native-host child must retain the sensitive-path/helper deny for ${deniedPath}`);
  }
});

test('native host launcher is a fixed binary so AppArmor Px reaches the nested profile', () => {
  const dockerfile = fs.readFileSync(path.resolve('platform/browser-agent/Dockerfile'), 'utf8');
  const launcher = fs.readFileSync(path.resolve('platform/browser-agent/native/native-host-launcher.c'), 'utf8');
  assert.match(dockerfile, /native-host-launcher\.c/);
  assert.match(dockerfile, /COPY --from=native-build .*war-native-host-launcher \/usr\/local\/bin\/war-native-host/);
  assert.match(launcher, /execv\(NODE_PATH, argv\)/);
  assert.doesNotMatch(dockerfile, /printf ['"]%s\\n['"] '#!\/bin\/sh'.*war-native-host/s);
});

test('SSH readiness attestation requires the loaded native-host AppArmor child', () => {
  const sshHostManager = fs.readFileSync(path.resolve('platform/controller-electron/src/sshHostManager.js'), 'utf8');
  assert.match(
    sshHostManager,
    /grep -Fxq 'war-browser-agent\/\/cloakbrowser-launcher\/\/war-native-host \(enforce\)' \/sys\/kernel\/security\/apparmor\/profiles/,
    'SSH readiness must reject hosts that have not loaded the native-host child profile',
  );
});
