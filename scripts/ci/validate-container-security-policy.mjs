import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.cwd();
const profilePath = path.join(root, 'platform', 'container', 'security', 'war-browser-agent.apparmor');
const workflowPath = path.join(root, '.github', 'workflows', 'container-real-world-gate.yml');
const adapterPath = path.join(root, 'platform', 'controller-electron', 'src', 'containerAdapter.js');
const smokeGatePath = path.join(root, 'platform', 'browser-agent', 'integration', 'containerGate.js');
const gatePath = path.join(root, 'platform', 'browser-agent', 'integration', 'realWorldContainerGate.js');
const probePath = path.join(root, 'scripts', 'ci', 'probe-chromium-sandbox-host.mjs');
const dockerfilePath = path.join(root, 'platform', 'browser-agent', 'Dockerfile');
const seccompPath = path.join(root, 'platform', 'container', 'security', 'chromium-userns-seccomp.json');
const browserControllerPath = path.join(root, 'platform', 'browser-agent', 'src', 'browserController.js');
const browserConfigPath = path.join(root, 'platform', 'browser-agent', 'src', 'config.js');
const extensionManifestPath = path.join(root, 'manifest.json');
const sshHostManagerPath = path.join(root, 'platform', 'controller-electron', 'src', 'sshHostManager.js');
const controllerApplicationPath = path.join(root, 'platform', 'controller-electron', 'src', 'controllerApplication.js');
const imageSbomGeneratorSourcePath = 'scripts/ci/generate-image-sbom.mjs';
const imageSbomGeneratorInstallPath = '/usr/local/lib/war/generate-image-sbom.mjs';
const cloakBrowserProvenanceSourcePath = 'platform/browser-agent/cloakbrowser-provenance.json';
const cloakBrowserProvenanceInstallPath = '/usr/share/doc/war-browser-agent/cloakbrowser-provenance.json';
const findings = [];
const launcherSourcePath = 'platform/browser-agent/native/cloakbrowser-sandbox-launcher.c';
const nativeBridgeProbeSourcePath = 'platform/browser-agent/native/native-bridge-policy-probe.c';
const nativeHostLauncherSourcePath = 'platform/browser-agent/native/native-host-launcher.c';
const launcherPath = '/usr/local/bin/war-cloakbrowser-sandbox-launcher';
const nativeBridgeProbePath = '/usr/local/bin/war-native-bridge-policy-probe';
const nativeHostPath = '/usr/local/bin/war-native-host';
const cloakBrowserPath = '/opt/war/cloakbrowser/chromium-146.0.7680.177.5/chrome';

const profile = fs.readFileSync(profilePath, 'utf8');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const runtimes = [adapterPath, smokeGatePath, gatePath, probePath].map((file) => fs.readFileSync(file, 'utf8'));
const [adapterRuntime, smokeGateRuntime, gateRuntime, probeRuntime] = runtimes;
const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
const nativeBridgeProbe = fs.readFileSync(path.join(root, nativeBridgeProbeSourcePath), 'utf8');
const nativeHostLauncher = fs.readFileSync(path.join(root, nativeHostLauncherSourcePath), 'utf8');
const seccompText = fs.readFileSync(seccompPath, 'utf8');
const seccomp = JSON.parse(seccompText);
const browserController = fs.readFileSync(browserControllerPath, 'utf8');
const browserConfig = fs.readFileSync(browserConfigPath, 'utf8');
const extensionManifest = JSON.parse(fs.readFileSync(extensionManifestPath, 'utf8'));
const sshHostManager = fs.readFileSync(sshHostManagerPath, 'utf8');
const controllerApplication = fs.readFileSync(controllerApplicationPath, 'utf8');
const imageSbomGenerator = fs.readFileSync(path.join(root, imageSbomGeneratorSourcePath), 'utf8');
const cloakBrowserProvenance = JSON.parse(fs.readFileSync(path.join(root, cloakBrowserProvenanceSourcePath), 'utf8'));
const APPROVED_APPARMOR_SHA256 = 'b6182de92e8ed7cf31350969042be50352136b3d1e5dccaf6d02aebfbcf2be08';
const APPROVED_SECCOMP_CANONICAL_SHA256 = '03ec0820f970cede78001a6b54e574dbc4c2bc0de05cdb53247102ac84cb3189';
const appArmorHash = crypto.createHash('sha256').update(profile).digest('hex');

const extensionPath = '/app/extension';
const extensionId = 'edoicfpldmlabgdalemfgflpldiijdmm';

assert((profile.match(/^\s*userns,\s*$/gm) || []).length === 1, 'AppArmor profile must contain exactly one userns rule');
const browserChildStart = profile.indexOf('profile cloakbrowser-launcher flags=(attach_disconnected,mediate_deleted)');
const nativeHostChildStart = profile.indexOf('profile war-native-host flags=(attach_disconnected,mediate_deleted)');
const browserChild = browserChildStart >= 0 ? profile.slice(browserChildStart, nativeHostChildStart >= 0 ? nativeHostChildStart : undefined) : '';
const nativeHostChild = nativeHostChildStart >= 0 ? profile.slice(nativeHostChildStart) : '';
assert(dockerfile.includes(launcherSourcePath), 'Dockerfile must compile the exact CloakBrowser sandbox launcher source');
assert(dockerfile.includes(nativeBridgeProbeSourcePath), 'Dockerfile must compile the native bridge policy probe source');
assert(dockerfile.includes(nativeHostLauncherSourcePath), 'Dockerfile must compile the native host launcher source');
assert(dockerfile.includes(launcherPath), 'Dockerfile must install the exact CloakBrowser sandbox launcher artifact');
assert(dockerfile.includes(nativeBridgeProbePath), 'Dockerfile must install the native bridge policy probe artifact');
assert(dockerfile.includes(nativeHostPath), 'Dockerfile must install the native host launcher artifact');
assert(nativeHostLauncher.includes('execv(NODE_PATH, argv)'), 'native host launcher must execute the fixed Node host entrypoint');
assert(new RegExp(`chown(?:\\s+-R)?\\s+root:root[^\\n]*${escapeRegExp(launcherPath)}`).test(dockerfile), 'Dockerfile must make the CloakBrowser sandbox launcher root-owned');
assert(new RegExp(`(?:chmod\\s+(?:a-w|0?555|0?755)[^\\n]*${escapeRegExp(launcherPath)}|find\\s+${escapeRegExp(launcherPath)}[^\\n]*-perm\\s+/222)`).test(dockerfile), 'Dockerfile must make and verify the CloakBrowser sandbox launcher non-writable');
assert(new RegExp(`chown(?:\\s+-R)?\\s+root:root[^\\n]*${escapeRegExp(nativeBridgeProbePath)}`).test(dockerfile), 'Dockerfile must make the native bridge policy probe root-owned');
assert(new RegExp(`(?:chmod\\s+(?:a-w|0?555|0?755)[^\\n]*${escapeRegExp(nativeBridgeProbePath)}|find\\s+${escapeRegExp(nativeBridgeProbePath)}[^\\n]*-perm\\s+/222)`).test(dockerfile), 'Dockerfile must make and verify the native bridge policy probe non-writable');
assert(dockerfile.includes(`COPY ${imageSbomGeneratorSourcePath} ${imageSbomGeneratorInstallPath}`), 'Dockerfile must embed the image SBOM generator');
assert(dockerfile.includes(`COPY ${cloakBrowserProvenanceSourcePath} ${cloakBrowserProvenanceInstallPath}`), 'Dockerfile must embed CloakBrowser provenance evidence');
assert(new RegExp('chown\\s+-R\\s+root:root[^\\n]*/usr/local/lib/war[^\\n]*/usr/share/doc/war-browser-agent').test(dockerfile), 'Dockerfile must make SBOM tooling and provenance root-owned');
assert(new RegExp('chmod\\s+-R\\s+a-w[^\\n]*/usr/local/lib/war[^\\n]*/usr/share/doc/war-browser-agent').test(dockerfile), 'Dockerfile must make SBOM tooling and provenance non-writable');
assert(dockerfile.includes(`test -s ${imageSbomGeneratorInstallPath}`), 'image build must verify the SBOM generator is present');
assert(dockerfile.includes(`test -s ${cloakBrowserProvenanceInstallPath}`), 'image build must verify CloakBrowser provenance is present');
assert(imageSbomGenerator.includes("execFileSync('dpkg-query'"), 'image SBOM must inventory installed dpkg packages');
assert(imageSbomGenerator.includes("path.join(root, 'node_modules')") && imageSbomGenerator.includes('lstatSync'), 'image SBOM must scan installed production npm packages without trusting package-lock alone');
assert(imageSbomGenerator.includes('lockMetadata.version !== metadata.version'), 'image SBOM must fail when installed npm packages drift from package-lock');
assert(!imageSbomGenerator.includes('debian-bookworm-runtime'), 'image SBOM must not silently fall back to a synthetic Debian inventory');
assert(cloakBrowserProvenance.binaryVersion === '146.0.7680.177.5', 'CloakBrowser provenance version must match the reviewed binary');
assert(cloakBrowserProvenance.archive?.sha256 === '4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e', 'CloakBrowser provenance digest must match the reviewed archive');
assert(browserChildStart >= 0 && profile.indexOf('\n    userns,', browserChildStart) > browserChildStart, 'AppArmor userns authority must exist only inside the launcher child profile');
assert(profile.includes(`${launcherPath} Cx -> cloakbrowser-launcher,`), 'AppArmor parent must transition only into the exact root-owned CloakBrowser sandbox launcher');
assert(!profile.includes(`${cloakBrowserPath} Cx ->`), 'AppArmor parent must not transition directly into CloakBrowser');
assert(!profile.includes('/usr/lib/chromium/chromium Cx ->'), 'AppArmor parent must not retain a direct legacy Chromium transition');
assert(profile.includes('profile cloakbrowser-launcher flags=(attach_disconnected,mediate_deleted)'), 'CloakBrowser launcher child profile must retain the reviewed confinement flags');
assert(profile.includes('profile war-native-host flags=(attach_disconnected,mediate_deleted)'), 'native host must be a CloakBrowser-nested AppArmor child');
assert(browserChild.includes(`${cloakBrowserPath} ix,`), 'CloakBrowser launcher child must inherit confinement into the exact pinned CloakBrowser executable');
assert(browserChild.includes(`${nativeHostPath} Px -> war-browser-agent//cloakbrowser-launcher//war-native-host,`), 'CloakBrowser launcher child must use a directed transition into its exact fully qualified child');
for (const runtimePath of ['/data/run/', '/data/run/**', '/run/war/', '/run/war/**']) {
  assert(new RegExp(`^\\s*audit deny ${escapeRegExp(runtimePath)}\\s+(?=[^,]*w)(?=[^,]*k)(?=[^,]*l)[^,]+,$`, 'm').test(browserChild), `CloakBrowser launcher child must deny pathname socket mutation for ${runtimePath}`);
}
assert(nativeHostChild.includes('/data/run/native-bridge.sock rw,'), 'native host must receive only the exact Agent bridge pathname socket grant');
assert(!/^\\s*\/data\/run\/(?:\*|\*\*)\s+[^,]+,$/m.test(nativeHostChild), 'native host must not receive wildcard Agent runtime access');
assert(!/^\\s*file,\\s*$/m.test(nativeHostChild), 'native host must not receive broad AppArmor file access');
for (const deniedPath of ['/data/device/**', '/data/workflows/**', '/data/terminal-outbox.json', '/run/war/**', '/usr/bin/xclip', '/usr/local/bin/war-xclip-sensitive']) {
  assert(new RegExp(`^\\s*audit deny ${escapeRegExp(deniedPath)}\\s+[^,]+,$`, 'm').test(nativeHostChild), `native host must deny ${deniedPath}`);
}
for (const symbol of ['BRIDGE_SOCKET', 'SIBLING_SOCKET', 'UNLINK_SENTINEL', 'connect_bridge', 'poll_bridge', 'unlink_sentinel', 'bind_and_listen_sibling', '/proc/self/attr/current']) {
  assert(nativeBridgeProbe.includes(symbol), `native bridge policy probe must report ${symbol}`);
}
assert(/\bstruct\s+pollfd\s+descriptor\s*=\s*\{/.test(nativeBridgeProbe) && !/\bconst\s+struct\s+pollfd\s+descriptor\s*=/.test(nativeBridgeProbe), 'native bridge policy probe pollfd descriptor must be mutable because poll writes revents');
assert(/\bpoll\s*\(\s*&descriptor\s*,\s*1\s*,\s*0\s*\)/.test(nativeBridgeProbe), 'native bridge policy probe must pass its pollfd descriptor to poll');
assert(!/\\bchange_profile\\b/.test(browserChild), 'CloakBrowser launcher child must not allow any change_profile transition');
assert(!profile.includes('default_allow'), 'AppArmor browser child must never use default_allow');
assert(!/\/\*\*.*(?:p|c)x\b/.test(profile), 'AppArmor profile must not grant wildcard executable transitions');
assert(!/flags=\([^)]*unconfined/.test(profile), 'AppArmor profile must not use an unconfined flag');
for (const rule of [
  'network,',
  'deny network alg,',
  'capability,',
  'file,',
  'umount,',
  'signal (receive) peer=unconfined,',
  'signal (receive) peer=runc,',
  'signal (receive) peer=crun,',
  'signal (receive) peer=dockerd,',
  'signal (send,receive) peer=@{profile_name},',
  'deny @{PROC}/* w,',
  'deny @{PROC}/{[^1-9/],[^1-9/][^0-9/],[^1-9s/][^0-9y/][^0-9s/],[^1-9/][^0-9/][^0-9/][^0-9/]*}/** w,',
  'deny @{PROC}/sys/[^k]** w,',
  'deny @{PROC}/sys/kernel/{?,??,[^s][^h][^m]**} w,',
  'deny @{PROC}/sysrq-trigger rwklx,',
  'deny @{PROC}/kcore rwklx,',
  'deny mount,',
  'deny /sys/[^f]*/** wklx,',
  'deny /sys/f[^s]*/** wklx,',
  'deny /sys/fs/[^c]*/** wklx,',
  'deny /sys/fs/c[^g]*/** wklx,',
  'deny /sys/fs/cg[^r]*/** wklx,',
  'deny /sys/firmware/** rwklx,',
  'deny /sys/devices/virtual/powercap/** rwklx,',
  'deny /sys/kernel/security/** rwklx,',
  'ptrace (trace,tracedby,read,readby) peer=@{profile_name},',
]) {
  assert(countExactRule(profile, rule) === 2, `AppArmor parent and browser child must both contain: ${rule}`);
}
assert(countExactRule(profile, 'network unix,') === 3, 'AppArmor parent, browser child, and native host must permit only reviewed Unix sockets');
assert(countExactRule(profile, 'signal (send,receive) peer=war-browser-agent//cloakbrowser-launcher,') === 1, 'AppArmor parent must permit exact launcher-child lifecycle signals');
assert(countExactRule(profile, 'signal (send,receive) peer=war-browser-agent,') === 1, 'AppArmor launcher child must permit exact parent lifecycle signals');
assert(countExactRule(profile, 'audit deny /data/device/ r,') === 2, 'Browser and native-host children must audit-deny listing the Agent identity directory');
assert(countExactRule(profile, 'audit deny /data/device/** rwklmx,') === 2, 'Browser and native-host children must audit-deny Agent identity and WSS credential access');
assert(profile.indexOf('audit deny /data/device/** rwklmx,') > browserChildStart, 'Agent identity audit denial must remain inside the browser child profile');
assert(countExactRule(profile, 'audit deny /data/workflows/ r,') === 2, 'Browser and native-host children must audit-deny workflow persistence listing');
assert(countExactRule(profile, 'audit deny /data/workflows/** rwklmx,') === 2, 'Browser and native-host children must audit-deny workflow persistence access');
assert(countExactRule(profile, 'audit deny /data/terminal-outbox.json rwkl,') === 2, 'Browser and native-host children must audit-deny the terminal outbox');
assert(countExactRule(profile, 'audit deny /run/war/x11-input.sock rwkl,') === 1, 'Only the browser child must audit-deny direct X11 input socket access');
assert(profile.indexOf('audit deny /run/war/x11-input.sock rwkl,') > browserChildStart, 'X11 input socket audit denial must remain inside the browser child profile');
for (const helperPath of ['/usr/bin/xclip', '/usr/local/bin/war-xclip-sensitive']) {
  const rule = `audit deny ${helperPath} rmx,`;
  assert(countExactRule(profile, rule) === 2, `Browser and native-host children must deny clipboard helper access: ${helperPath}`);
  assert(profile.indexOf(rule) > browserChildStart, `Clipboard helper denial must remain inside the browser child profile: ${helperPath}`);
}
assert(appArmorHash === APPROVED_APPARMOR_SHA256, 'AppArmor profile hash changed without updating the reviewed hash');
assert(sshHostManager.includes(`const APPROVED_APPARMOR_SHA256 = '${APPROVED_APPARMOR_SHA256}'`), 'SSH attestation hash must match the reviewed AppArmor profile');
assert(workflow.includes('sudo install -o root -g root -m 0644'), 'workflow must install the AppArmor profile as root-owned mode 0644');
assert(workflow.includes('sudo apparmor_parser -r -W'), 'workflow must load the reviewed AppArmor profile');
assert(workflow.includes('sudo apparmor_parser -R'), 'workflow must unload the temporary AppArmor profile');
for (const runtime of runtimes) {
  assert(runtime.includes('war-browser-agent'), 'runtime must retain the reviewed AppArmor profile as its default');
  assert(runtime.includes('apparmor='), 'runtime must select an AppArmor profile explicitly');
  assert(runtime.includes('seccomp='), 'runtime must select the reviewed seccomp profile');
  assert(runtime.includes("'--cap-drop', 'ALL'"), 'runtime must drop every Linux capability');
  assert(!/--privileged\\b/.test(runtime), 'runtime must not enable privileged containers');
  assert(!/--no-sandbox\\b/.test(runtime), 'runtime must not disable the Chromium sandbox');
  assert(runtime.includes("'--memory', '2g'"), 'runtime must bound container memory');
  assert(runtime.includes("'--cpus', '2'"), 'runtime must bound container CPU');
  assert(runtime.includes("'--pids-limit', '512'"), 'runtime must bound container PIDs');
  assert(!runtime.includes('apparmor=unconfined'), 'runtime must not disable AppArmor');
}
const chromiumLaunchRuntime = functionSource(adapterRuntime, '\n  async launchContainer(', '\n  controllerWssUrl()');
const helperRuntime = functionSource(adapterRuntime, '\n  helperContainerArgs() {', '\n  async resolveDesiredNetwork(');
const controllerHostGatewayRuntime = functionSource(adapterRuntime, '\n  controllerHostGatewayArgs() {', '\n  seccompProfilePath()');
const gateBrowserRuntime = gateRuntime.split('async function resolveRuntimeUser')[0];
const productionRuntimes = [chromiumLaunchRuntime, smokeGateRuntime, gateBrowserRuntime, probeRuntime];
for (const runtime of productionRuntimes) {
  assert(!/--cap-add\\b/.test(runtime), 'production runtime must not add Linux capabilities');
}
for (const runtime of [chromiumLaunchRuntime, smokeGateRuntime, gateBrowserRuntime, probeRuntime]) {
  assert(!runtime.includes('no-new-privileges:true'), 'exact AppArmor userns transition must not be blocked by no-new-privileges');
}
for (const runtime of [smokeGateRuntime, gateRuntime, probeRuntime]) {
  assert(runtime.includes('WAR_BROWSER_AGENT_IMAGE'), 'container gates must accept an explicit canary image selection');
  assert(runtime.includes('WAR_BROWSER_AGENT_APPARMOR_PROFILE'), 'container gates must accept an explicit canary AppArmor profile selection');
  assert(runtime.includes('imageId'), 'container gates must record the resolved immutable image ID');
  assert(runtime.includes('sha256:'), 'container gates must reject mutable-only image evidence');
}
assert(smokeGateRuntime.includes('/opt/war/cloakbrowser/chromium-146.0.7680.177.5/chrome'), 'container smoke must measure the pinned CloakBrowser binary rather than ordinary Chromium');
assert(gateRuntime.includes('resolveRuntimeUser'), 'real-world gate must resolve the immutable image runtime UID/GID before bind mounting data');
assert(gateRuntime.includes('prepareContainerDataDir'), 'real-world gate must prepare bind-mounted data ownership before container launch');
assert(gateRuntime.includes("process.platform !== 'linux'"), 'real-world bind-mount ownership must fail closed outside Linux');
assert(gateRuntime.includes("'--entrypoint', 'id'"), 'real-world gate must resolve the image runtime user without assuming a fixed UID');
assert(gateRuntime.includes('{{.Config.User}}'), 'real-world gate must attest the image default runtime user before launch');
assert(gateRuntime.includes("configuredUser !== 'war'"), 'real-world gate must keep the reviewed war runtime identity aligned with the probe');
assert(gateRuntime.includes("'--network', 'none'") && gateRuntime.includes("'--read-only'"), 'runtime UID probe must have no network and a read-only filesystem');
assert(gateRuntime.includes("'--cap-drop', 'ALL'") && gateRuntime.includes("'--pids-limit', '16'"), 'runtime UID probe must be capability- and process-bounded');
assert(gateRuntime.includes("'--cap-add', 'CHOWN'") && gateRuntime.includes("'--cap-add', 'DAC_OVERRIDE'") && gateRuntime.includes("'--cap-add', 'FOWNER'"), 'ownership helper must use only narrowly scoped filesystem capabilities');
assert(helperRuntime.includes('no-new-privileges:true'), 'credential helper containers must enforce no-new-privileges');
assert(chromiumLaunchRuntime.includes('...this.controllerHostGatewayArgs()'), 'managed containers must gate host-gateway access on the selected Controller endpoint');
assert(!chromiumLaunchRuntime.includes('host.docker.internal:host-gateway'), 'managed containers must not receive the Docker host gateway unconditionally');
assert(controllerHostGatewayRuntime.includes("host?.toLowerCase() === 'host.docker.internal'"), 'host-gateway access must require the exact explicit host.docker.internal endpoint');
assert(sshHostManager.includes("'--',\n      host.target,\n      command"), 'SSH host readiness must terminate local options before the destination');
assert(adapterRuntime.includes("'--',\n      this.config.sshTarget,\n      command"), 'managed SSH Docker must terminate local options before the destination');
assert(!sshHostManager.includes("host.target,\n      '--', command"), 'SSH host readiness must not send -- as the remote command');
assert(!adapterRuntime.includes("this.config.sshTarget,\n      '--', command"), 'managed SSH Docker must not send -- as the remote command');
assert(!/^\s*chromium-sandbox\s*\\?\s*$/m.test(dockerfile), 'userns-only image must not install the Chromium SUID helper package');
assert(!/^\s*chromium\s*\\?\s*$/m.test(dockerfile), 'CloakBrowser image must not install ordinary Chromium');
assert(dockerfile.includes('test ! -e /opt/war/cloakbrowser/chromium-${CLOAKBROWSER_VERSION}/chrome-sandbox'), 'image build must verify the CloakBrowser SUID helper is absent');
assert(dockerfile.includes('find / -xdev \\( -type f -o -type d \\) \\( -perm /4000 -o -perm /2000 \\) -exec chmod a-s {} +'), 'userns-only image must strip all SUID and SGID bits from files and directories');
assert(dockerfile.includes('find /opt/war/cloakbrowser -xdev \\( -type f -o -type d \\) -perm /222'), 'image build must verify CloakBrowser files and directories are non-writable by mode');
assert(dockerfile.includes('verifySignature(manifest.manifestBytes, manifest.sigBytes)'), 'image build must verify the vendor-signed CloakBrowser manifest');
assert(dockerfile.includes('4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e'), 'image build must pin the reviewed CloakBrowser archive SHA-256');
assert(dockerfile.includes('WAR_BROWSER_ENGINE=cloakbrowser'), 'production image must select CloakBrowser explicitly');
assert(!dockerfile.includes('CLOAKBROWSER_LICENSE_KEY'), 'CloakBrowser license keys must never be baked into the image');
assert(extensionManifest.key === undefined, 'keyless extension identity must remain path-derived unless a reviewed identity migration is performed');
assert(pathDerivedExtensionId(extensionPath) === extensionId, 'canonical extension path must derive the approved extension ID');
assert(dockerfile.includes(`WAR_EXTENSION_DIR=${extensionPath}`), 'image must keep the canonical extension path used by the approved extension ID');
assert(dockerfile.includes('COPY manifest.json ./extension/manifest.json'), 'image must install the built-in extension at the canonical path');
assert(dockerfile.includes(`"allowed_origins": ["chrome-extension://${extensionId}/"]`), 'native host must trust only the approved built-in extension ID');
assert(browserConfig.includes(`extensionId: '${extensionId}'`), 'Browser Agent must require the approved built-in extension ID');
assert(browserConfig.includes(`extensionDir: '${extensionPath}'`), 'Browser Agent must use the canonical built-in extension path');
assert(!browserController.includes('WAR_NATIVE_HOST_PATH'), 'Browser Agent must not install or mutate native messaging manifests at runtime');
assert(!browserController.includes('allowed_origins'), 'Browser Agent must not discover or rewrite native messaging origins at runtime');
assert(crypto.createHash('sha256').update(seccompText).digest('hex') === '6b0e60321eb4b9d774eb4eee0baa7b03d0c6b6141a593b5312e42356cf510c67', 'Chromium seccomp profile hash changed without review');
assert(seccomp.defaultAction === 'SCMP_ACT_ERRNO', 'Chromium seccomp profile must retain the Docker default deny action');
const chromiumRules = seccomp.syscalls.filter((rule) => String(rule.comment || '').startsWith('Allow Chromium'));
const chrootRules = seccomp.syscalls.filter((rule) => rule.names?.includes('chroot'));
const canonicalSeccompHash = crypto.createHash('sha256').update(JSON.stringify(seccomp)).digest('hex');
assert(canonicalSeccompHash === APPROVED_SECCOMP_CANONICAL_SHA256, 'Chromium seccomp canonical policy hash changed without review');
assert(chrootRules.length === 1, 'seccomp must contain exactly one chroot allow rule');
assert(chrootRules[0]?.action === 'SCMP_ACT_ALLOW' && !chrootRules[0]?.args?.length && !chrootRules[0]?.includes && !chrootRules[0]?.excludes, 'seccomp chroot allow must be unconditional');
assert(!seccomp.syscalls.some((rule) => rule.includes?.caps?.includes('CAP_SYS_CHROOT')), 'seccomp must not condition chroot on CAP_SYS_CHROOT');
assert(chromiumRules.length === 4, 'Chromium seccomp profile must add exactly four reviewed rules');
assert(chromiumRules.every((rule) => rule.action === 'SCMP_ACT_ALLOW' && rule.args?.length === 1 && rule.args[0].op === 'SCMP_CMP_MASKED_EQ' && rule.args[0].value === 0x7e020000), 'Chromium seccomp additions must use the reviewed namespace mask');
assert(JSON.stringify(chromiumRules.filter((rule) => rule.names[0] === 'clone').map((rule) => rule.args[0].valueTwo).sort((a, b) => a - b)) === JSON.stringify([0x10000000, 0x20000000, 0x70000000]), 'Chromium clone namespace combinations changed');
assert(chromiumRules.some((rule) => rule.names[0] === 'unshare' && rule.args[0].valueTwo === 0x10000000), 'Chromium user namespace unshare rule is missing');
assert(chromiumRules.every((rule) => ['clone', 'unshare'].includes(rule.names[0])), 'Chromium seccomp additions must not allow unrelated syscalls');
assert(browserController.includes("page.goto('chrome://sandbox/'"), 'Browser Agent must query Chromium sandbox status from chrome://sandbox');
assert(browserController.includes("document.querySelectorAll('#sandbox-status tr')"), 'Browser Agent must read the Chromium-rendered sandbox status table');
assert(browserController.includes("document.querySelector('#evaluation')"), 'Browser Agent must read Chromium overall sandbox evaluation');
assert(probeRuntime.includes('if (!report.classification.supported) process.exitCode = 1'), 'sandbox capability probe must fail CI when authoritative proof is unavailable');
assert(probeRuntime.includes("import playwright from '/app/node_modules/playwright-core/index.js'"), 'sandbox probe must use the CommonJS-compatible Playwright import');
assert(!probeRuntime.includes("import { chromium } from '/app/node_modules/playwright-core/index.js'"), 'sandbox probe must not use an unsupported named import from Playwright CommonJS');
assert(sshHostManager.includes("const DEFAULT_APPARMOR_PATH = '/etc/apparmor.d/war-browser-agent'"), 'Linux attestation must use the AppArmor boot-persistent top-level profile path');
assert(!sshHostManager.includes('/etc/apparmor.d/containers/war-browser-agent'), 'Linux attestation must not rely on an AppArmor subdirectory ignored at reboot');
assert(sshHostManager.includes("grep -Fxq 'war-browser-agent (enforce)' /sys/kernel/security/apparmor/profiles"), 'Linux readiness must require the parent AppArmor profile in enforce mode');
assert(sshHostManager.includes("grep -Fxq 'war-browser-agent//cloakbrowser-launcher (enforce)' /sys/kernel/security/apparmor/profiles"), 'Linux readiness must reject an unconfined CloakBrowser launcher child');
assert(sshHostManager.includes("grep -Fxq 'war-browser-agent//cloakbrowser-launcher//war-native-host (enforce)' /sys/kernel/security/apparmor/profiles"), 'Linux readiness must reject a missing native-host child profile');
assert(gateRuntime.includes("'--entrypoint', '/usr/local/bin/war-native-bridge-policy-probe'"), 'real-world gate must execute the root-owned native bridge policy probe');
assert(gateRuntime.includes('apparmor=${runtime.appArmor}//cloakbrowser-launcher'), 'real-world gate must force the policy probe directly into the browser child profile');
assert(gateRuntime.includes("'--network', `container:${container}`"), 'real-world gate must share only the Agent network namespace with the policy probe');
assert(gateRuntime.includes('os.constants.errno.EACCES'), 'real-world gate must require AppArmor EACCES denial evidence');
assert(sshHostManager.includes("codedError('HOST_PROVISIONING_REQUIRED'"), 'Linux repair must report immutable provisioning prerequisites without mutating the host');
for (const mutation of ['apparmor_parser', 'apt-get', 'systemctl', 'docker build', 'git clone', 'git fetch', 'git pull']) {
  assert(!sshHostManager.includes(mutation), `Linux host manager must not mutate host provisioning through: ${mutation}`);
}
assert(adapterRuntime.includes('matchesApprovedSeccompSecurityOption(securityOptions)'), 'managed runtime must verify Docker measured seccomp policy content');
assert(!adapterRuntime.includes("const DEFAULT_IMAGE = 'war-browser-agent:phase1'"), 'managed runtime must not fall back to a mutable Docker image tag');
assert(!sshHostManager.includes("const DEFAULT_IMAGE = 'war-browser-agent:phase1'"), 'SSH host manager must not fall back to a mutable Docker image tag');
const provisioningBoundary = functionSource(controllerApplication, '  async addContainer(payload) {', '  async startContainer(');
assert(provisioningBoundary.includes('await hostAdapter.attestImage'), 'application must attest the host image before pairing provisioning');
assert(provisioningBoundary.indexOf('await hostAdapter.attestImage') < provisioningBoundary.indexOf('provisionManagedAgent'), 'image attestation must precede pairing provisioning');
assert(adapterRuntime.includes(APPROVED_SECCOMP_CANONICAL_SHA256), 'managed runtime canonical seccomp hash must match the reviewed policy');
assert(gateRuntime.includes('seccompPolicyMatched'), 'real-world evidence must record only the sanitized seccomp policy match');
assert(!gateRuntime.includes("seccompProfile: securityOptions.find"), 'real-world evidence must not persist the full Docker seccomp JSON');

if (findings.length) {
  console.error(findings.join('\n'));
  process.exit(1);
}
console.log(JSON.stringify({ result: 'PASS', profile: 'war-browser-agent', browserPath: '/opt/war/cloakbrowser/chromium-146.0.7680.177.5/chrome' }, null, 2));

function assert(condition, message) {
  if (!condition) findings.push(message);
}

function functionSource(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert(start >= 0 && end > start, `runtime source markers are missing: ${startMarker}`);
  return start >= 0 && end > start ? source.slice(start, end) : source;
}

function pathDerivedExtensionId(extensionPath) {
  const digest = crypto.createHash('sha256').update(extensionPath).digest().subarray(0, 16);
  return [...digest].map((byte) => String.fromCharCode(
    97 + (byte >> 4),
    97 + (byte & 0x0f),
  )).join('');
}

function countExactRule(source, rule) {
  return source.split(/\r?\n/).filter((line) => line.trim() === rule).length;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
