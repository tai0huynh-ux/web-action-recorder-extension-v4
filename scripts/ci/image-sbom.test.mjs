import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SBOM_PATH = path.resolve('platform/browser-agent/SBOM.spdx.json');
const GENERATOR_PATH = path.resolve('scripts/ci/generate-image-sbom.mjs');
const IMAGE_ID = 'sha256:'.concat('a'.repeat(64));
const SOURCE_REVISION = 'e'.repeat(40);
const CLOAKBROWSER_ARCHIVE_SHA256 = '4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e';
const XCLIP_ARCHIVE_SHA256 = '2bb193f5ac15872bc1b2579643bebf6303804b98e7b6bcc55ff2be9921843a4a';
const DEBIAN_PACKAGES = [{
  name: 'ca-certificates',
  version: '20230311+deb12u1',
  architecture: 'amd64',
  purl: 'pkg:deb/debian/ca-certificates@20230311%2Bdeb12u1?arch=amd64',
}];
const NPM_PACKAGES = [{
  name: 'playwright-core',
  version: '1.61.1',
  license: 'Apache-2.0',
  downloadLocation: 'https://registry.npmjs.org/playwright-core/-/playwright-core-1.61.1.tgz',
  installPath: 'playwright-core@1.61.1',
  purl: 'pkg:npm/playwright-core@1.61.1',
}];

function packageByName(sbom, name) {
  return sbom.packages?.find((entry) => entry.name === name);
}

function hasSha256(entry, digest) {
  return entry?.checksums?.some(({ algorithm, checksumValue }) => algorithm === 'SHA256' && checksumValue === digest) === true;
}

function assertImageSbom(sbom, sourceRevision) {
  assert.equal(sbom.spdxVersion, 'SPDX-2.3');
  assert.equal(sbom.dataLicense, 'CC0-1.0');
  assert.ok(Array.isArray(sbom.relationships), 'image SBOM must declare SPDX relationships');
  assert.ok(sbom.relationships.some((entry) => entry.spdxElementId === 'SPDXRef-DOCUMENT' && entry.relationshipType === 'DESCRIBES'), 'image SBOM must describe the immutable Browser Agent image package');

  const image = packageByName(sbom, 'web-action-recorder-browser-agent-image');
  assert.ok(image, 'image SBOM must identify the Browser Agent image as an SPDX package');
  assert.match(image.sourceInfo || '', /git\+.*@[0-9a-f]{40}/i, 'image package must record the source revision');
  assert.match(image.sourceInfo || '', new RegExp(sourceRevision), 'image package must record the supplied source revision');

  const debian = packageByName(sbom, 'debian-bookworm-packages');
  assert.ok(debian, 'image SBOM must cover installed Debian packages');
  assert.match(debian.externalRefs?.find((entry) => entry.referenceType === 'purl')?.referenceLocator || '', /^pkg:deb\/debian\//, 'Debian package inventory must carry a Debian purl');

  const npm = packageByName(sbom, 'browser-agent-npm-dependencies');
  assert.ok(npm, 'image SBOM must cover installed npm dependencies');
  assert.match(npm.externalRefs?.find((entry) => entry.referenceType === 'purl')?.referenceLocator || '', /^pkg:npm\//, 'npm dependency inventory must carry an npm purl');

  const nodeBase = packageByName(sbom, 'node:22-bookworm-slim');
  assert.ok(nodeBase, 'image SBOM must identify the pinned Node/base image');
  assert.equal(hasSha256(nodeBase, nodeBase?.checksums?.find((entry) => entry.algorithm === 'SHA256')?.checksumValue), true, 'base image must include a sha256 digest');

  const cloakbrowser = packageByName(sbom, 'cloakbrowser');
  assert.equal(cloakbrowser?.versionInfo, '146.0.7680.177.5', 'image SBOM must identify the pinned CloakBrowser version');
  assert.equal(hasSha256(cloakbrowser, CLOAKBROWSER_ARCHIVE_SHA256), true, 'image SBOM must retain the CloakBrowser archive digest');
  assert.equal(cloakbrowser?.licenseConcluded, 'LicenseRef-CloakBrowser', 'CloakBrowser must use its declared license reference');
  assert.ok(sbom.hasExtractedLicensingInfos?.some((entry) => entry.licenseId === 'LicenseRef-CloakBrowser' && /CloakBrowser/i.test(entry.extractedText || '')), 'image SBOM must contain CloakBrowser LicenseRef evidence');

  const xclip = packageByName(sbom, 'xclip-sensitive');
  assert.equal(xclip?.licenseConcluded, 'GPL-2.0-or-later');
  assert.equal(hasSha256(xclip, XCLIP_ARCHIVE_SHA256), true, 'image SBOM must retain xclip source archive evidence');
  assert.match(xclip?.downloadLocation || '', /github\.com\/astrand\/xclip\/archive\//, 'image SBOM must retain xclip source location');

  for (const component of [debian, npm, nodeBase, cloakbrowser, xclip]) {
    assert.ok(sbom.relationships.some((entry) => entry.spdxElementId === image.SPDXID && entry.relationshipType === 'CONTAINS' && entry.relatedSpdxElement === component.SPDXID), `image SBOM must relate ${component?.name} to the immutable image`);
  }
}

function assertImageBinding(binding, sbomBytes, imageId) {
  assert.equal(binding.schemaVersion, 1, 'image SBOM binding must declare schema version 1');
  assert.equal(binding.subject?.imageId, imageId, 'image SBOM binding subject must equal the attested immutable image ID');
  assert.equal(binding.sbom?.path, 'SBOM.spdx.json', 'image SBOM binding must name the packaged SPDX artifact');
  assert.equal(binding.sbom?.sha256, crypto.createHash('sha256').update(sbomBytes).digest('hex'), 'image SBOM binding hash must equal the packaged SPDX bytes');
}

function dockerBindMountSource(args) {
  const mountIndex = args.indexOf('--mount');
  assert.notEqual(mountIndex, -1, 'generator must bind-mount the prepared artifact directory');
  const options = Object.fromEntries(args[mountIndex + 1].split(',').map((entry) => entry.split('=')));
  assert.equal(options.type, 'bind', 'artifact output must use a bind mount');
  assert.equal(options.dst, '/out', 'container must receive artifacts only at /out');
  assert.equal(typeof options.src, 'string', 'bind mount must declare a host source directory');
  return options.src;
}

test('image SBOM fixture model accepts every required image component and SPDX relationship', () => {
  const image = { name: 'web-action-recorder-browser-agent-image', SPDXID: 'SPDXRef-Package-Image', sourceInfo: `git+https://example.invalid/web-action-recorder.git@${SOURCE_REVISION}` };
  const debian = { name: 'debian-bookworm-packages', SPDXID: 'SPDXRef-Package-Debian', externalRefs: [{ referenceType: 'purl', referenceLocator: 'pkg:deb/debian/curl@8.0.0' }] };
  const npm = { name: 'browser-agent-npm-dependencies', SPDXID: 'SPDXRef-Package-Npm', externalRefs: [{ referenceType: 'purl', referenceLocator: 'pkg:npm/playwright@1.0.0' }] };
  const nodeBase = { name: 'node:22-bookworm-slim', SPDXID: 'SPDXRef-Package-Node', checksums: [{ algorithm: 'SHA256', checksumValue: 'b'.repeat(64) }] };
  const cloakbrowser = { name: 'cloakbrowser', SPDXID: 'SPDXRef-Package-CloakBrowser', versionInfo: '146.0.7680.177.5', licenseConcluded: 'LicenseRef-CloakBrowser', checksums: [{ algorithm: 'SHA256', checksumValue: CLOAKBROWSER_ARCHIVE_SHA256 }] };
  const xclip = { name: 'xclip-sensitive', SPDXID: 'SPDXRef-Package-Xclip', licenseConcluded: 'GPL-2.0-or-later', downloadLocation: 'https://github.com/astrand/xclip/archive/2c3b811002b35d3be7f39cc1145dd06bdb32e31c.tar.gz', checksums: [{ algorithm: 'SHA256', checksumValue: XCLIP_ARCHIVE_SHA256 }] };
  const sbom = {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    relationships: [
      { spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: image.SPDXID },
      ...[debian, npm, nodeBase, cloakbrowser, xclip].map((component) => ({ spdxElementId: image.SPDXID, relationshipType: 'CONTAINS', relatedSpdxElement: component.SPDXID })),
    ],
    hasExtractedLicensingInfos: [{ licenseId: 'LicenseRef-CloakBrowser', extractedText: 'CloakBrowser commercial license terms' }],
    packages: [image, debian, npm, nodeBase, cloakbrowser, xclip],
  };
  assertImageSbom(sbom, SOURCE_REVISION);
});

test('checked-in xclip SPDX is explicitly legacy provenance, not a complete image SBOM', () => {
  const legacy = JSON.parse(fs.readFileSync(SBOM_PATH, 'utf8'));
  assert.equal(legacy.name, 'xclip-sensitive-source-provenance');
  assert.deepEqual(legacy.packages?.map((entry) => entry.name), ['xclip-sensitive']);
  assert.equal(legacy.relationships, undefined, 'legacy xclip provenance must not be mistaken for an image-level SBOM');
});

test('image SBOM binding rejects an immutable image subject or SPDX hash mismatch', () => {
  const sbomBytes = Buffer.from('{"spdxVersion":"SPDX-2.3"}\n');
  const validBinding = { schemaVersion: 1, subject: { imageId: IMAGE_ID }, sbom: { path: 'SBOM.spdx.json', sha256: crypto.createHash('sha256').update(sbomBytes).digest('hex') } };
  assert.doesNotThrow(() => assertImageBinding(validBinding, sbomBytes, IMAGE_ID));
  assert.throws(() => assertImageBinding({ ...validBinding, subject: { imageId: 'sha256:'.concat('c'.repeat(64)) } }, sbomBytes, IMAGE_ID), /subject/);
  assert.throws(() => assertImageBinding({ ...validBinding, sbom: { ...validBinding.sbom, sha256: 'd'.repeat(64) } }, sbomBytes, IMAGE_ID), /hash/);
});

test('Docker SBOM generation rejects an unsupported host before Docker is invoked', async (t) => {
  if (process.platform === 'linux' && process.getuid?.() === 0) return t.skip('requires an unsupported host');
  const { generateDockerImageSbom: generate } = await import(new URL('./generate-image-sbom-for-docker.mjs', import.meta.url));
  let called = false;
  await assert.rejects(generate({ imageId: IMAGE_ID, sourceRevision: SOURCE_REVISION, outputDir: path.resolve(os.tmpdir(), 'war-image-sbom-unsupported'), docker: async () => { called = true; throw new Error('Docker must not run'); } }), /requires Linux root/);
  assert.equal(called, false);
});

test('image SBOM generator accepts build inputs and emits a hash-bound image sidecar', async () => {
  assert.ok(fs.existsSync(GENERATOR_PATH), 'image SBOM generator must exist for the build-time immutable image ID');
  const { generateImageSbom } = await import(new URL('./generate-image-sbom.mjs', import.meta.url));
  assert.equal(typeof generateImageSbom, 'function', 'image SBOM generator must export generateImageSbom');

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'war-image-sbom-'));
  try {
    const output = await generateImageSbom({
      sourceRevision: SOURCE_REVISION,
      imageId: IMAGE_ID,
      outputDir,
      debianPackages: DEBIAN_PACKAGES,
      npmPackages: NPM_PACKAGES,
    });
    assert.equal(output.sbomPath, path.join(outputDir, 'SBOM.spdx.json'));
    assert.equal(output.bindingPath, path.join(outputDir, 'SBOM.image-binding.json'));
    const sbomBytes = fs.readFileSync(output.sbomPath);
    assertImageSbom(JSON.parse(sbomBytes), SOURCE_REVISION);
    assertImageBinding(JSON.parse(fs.readFileSync(output.bindingPath, 'utf8')), sbomBytes, IMAGE_ID);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('root Docker SBOM generation rejects a symlinked produced artifact without mutating its target', async (t) => {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() !== 0) {
    t.skip('requires Linux root symlink and ownership semantics');
    return;
  }

  const { generateDockerImageSbom } = await import(new URL('./generate-image-sbom-for-docker.mjs', import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'war-image-sbom-symlink-race-'));
  const outputDir = path.join(root, 'out');
  const sentinelPath = path.join(root, 'sentinel');
  const sentinelBytes = Buffer.from('do-not-modify-sbom-sentinel\n');
  fs.writeFileSync(sentinelPath, sentinelBytes, { mode: 0o600 });
  const before = fs.statSync(sentinelPath);

  try {
    let runCalled = false;
    const generationError = await generateDockerImageSbom({
      imageId: IMAGE_ID,
      sourceRevision: SOURCE_REVISION,
      outputDir,
      docker: async (args) => {
        if (args[0] === 'context') return { stdout: 'unix:///var/run/docker.sock\n' };
        if (args[0] === 'info') return { stdout: '["name=apparmor","name=seccomp","name=cgroupns"]\n' };
        if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n` };
        assert.equal(args[0], 'run', 'generator must invoke Docker only for image inspection and SBOM production');
        runCalled = true;
        const bindSource = dockerBindMountSource(args);
        const sbomPath = path.join(bindSource, 'SBOM.spdx.json');
        fs.unlinkSync(sbomPath);
        fs.symlinkSync(sentinelPath, sbomPath);
        fs.writeFileSync(path.join(bindSource, 'SBOM.image-binding.json'), `${JSON.stringify({
          subject: { imageId: IMAGE_ID },
          sbom: { sha256: crypto.createHash('sha256').update(sentinelBytes).digest('hex') },
        })}\n`);
        return { stdout: '' };
      },
    }).then(() => undefined, (error) => error);

    assert.equal(runCalled, true, 'mock Docker writer must replace the expected SBOM artifact');
    assert.ok(generationError, 'generation must reject a produced SBOM symlink');

    const after = fs.statSync(sentinelPath);
    assert.deepEqual(
      { dev: after.dev, ino: after.ino, uid: after.uid, gid: after.gid, mode: after.mode & 0o777, bytes: fs.readFileSync(sentinelPath) },
      { dev: before.dev, ino: before.ino, uid: before.uid, gid: before.gid, mode: before.mode & 0o777, bytes: sentinelBytes },
      'rejecting the symlink must leave the sentinel identity, ownership, mode, and content unchanged',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('root Docker SBOM generation rejects a replaceable output ancestor before image execution', async (t) => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) return t.skip('requires Linux root ownership semantics');
  const { generateDockerImageSbom: generate } = await import(new URL('./generate-image-sbom-for-docker.mjs', import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'war-image-sbom-ancestor-'));
  const unsafe = path.join(root, 'unsafe'); const parent = path.join(unsafe, 'trusted'); const sentinel = path.join(unsafe, 'sentinel');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); fs.chmodSync(unsafe, 0o777); fs.writeFileSync(sentinel, 'unchanged');
  const before = fs.statSync(sentinel); const calls = [];
  try {
    const error = await generate({ imageId: IMAGE_ID, sourceRevision: SOURCE_REVISION, outputDir: path.join(parent, 'out'), docker: async (args) => {
      calls.push(args);
      if (args[0] === 'context') return { stdout: 'unix:///var/run/docker.sock\n' };
      if (args[0] === 'info') return { stdout: '["name=apparmor","name=seccomp","name=cgroupns"]\n' };
      return { stdout: args[0] === 'image' ? `${IMAGE_ID}\n` : '' };
    } }).then(() => undefined, (reason) => reason);
    assert.match(error?.message || '', /ancestor.*replaceable by another user/i);
    assert.equal(calls.some((args) => args[0] === 'image' || args[0] === 'run'), false);
    assert.deepEqual({ mtimeMs: fs.statSync(sentinel).mtimeMs, bytes: fs.readFileSync(sentinel) }, { mtimeMs: before.mtimeMs, bytes: Buffer.from('unchanged') });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('root Docker SBOM generation publishes valid pre-created artifacts as root-owned regular files', async (t) => {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() !== 0) {
    t.skip('requires Linux root ownership semantics');
    return;
  }

  const { generateDockerImageSbom } = await import(new URL('./generate-image-sbom-for-docker.mjs', import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'war-image-sbom-positive-'));
  const outputDir = path.join(root, 'out');
  const sbomBytes = Buffer.from('{"spdxVersion":"SPDX-2.3"}\n');
  const bindingBytes = Buffer.from(`${JSON.stringify({
    subject: { imageId: IMAGE_ID },
    sbom: { sha256: crypto.createHash('sha256').update(sbomBytes).digest('hex') },
  })}\n`);

  try {
    const calls = [];
    const output = await generateDockerImageSbom({
      imageId: IMAGE_ID,
      sourceRevision: SOURCE_REVISION,
      outputDir,
      docker: async (args) => {
        calls.push(args);
        if (args[0] === 'context') return { stdout: 'unix:///var/run/docker.sock\n' };
        if (args[0] === 'info') return { stdout: '["name=apparmor","name=seccomp","name=cgroupns"]\n' };
        if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n` };
        assert.equal(args[0], 'run', 'generator must invoke Docker only for image inspection and SBOM production');
        const bindSource = dockerBindMountSource(args);
        for (const [name, bytes] of [['SBOM.spdx.json', sbomBytes], ['SBOM.image-binding.json', bindingBytes]]) {
          const prepared = fs.lstatSync(path.join(bindSource, name));
          assert.equal(prepared.isFile(), true, `${name} must be pre-created as a regular file`);
          assert.equal(prepared.isSymbolicLink(), false, `${name} must not be a symlink`);
          assert.equal(prepared.uid, 1000, `${name} must be writable by the container user`);
          assert.equal(prepared.gid, 1000, `${name} must belong to the container group`);
          assert.equal(prepared.mode & 0o777, 0o600, `${name} must begin private`);
          fs.writeFileSync(path.join(bindSource, name), bytes);
        }
        return { stdout: '' };
      },
    });

    assert.equal(output.sbomPath, path.join(outputDir, 'SBOM.spdx.json'));
    assert.equal(output.bindingPath, path.join(outputDir, 'SBOM.image-binding.json'));
    assert.deepEqual(calls.slice(0, 2), [
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      ['info', '--format', '{{json .SecurityOptions}}'],
    ], 'generation must preflight a local rootful daemon before inspecting the image');
    const run = calls.find((args) => args[0] === 'run');
    assert.equal(run[run.indexOf('--user') + 1], '1000:1000', 'container writer must use the prepared artifact owner');
    for (const [artifactPath, bytes] of [[output.sbomPath, sbomBytes], [output.bindingPath, bindingBytes]]) {
      const artifact = fs.lstatSync(artifactPath);
      assert.equal(artifact.isFile(), true, 'published artifact must be a regular file');
      assert.equal(artifact.isSymbolicLink(), false, 'published artifact must not be a symlink');
      assert.equal(artifact.uid, 0, 'published artifact must be root-owned');
      assert.equal(artifact.gid, 0, 'published artifact must be root-group-owned');
      assert.equal(artifact.mode & 0o777, 0o644, 'published artifact must be world-readable and not writable');
      assert.deepEqual(fs.readFileSync(artifactPath), bytes, 'published artifact content must match the container output');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime npm inventory scans installed package directories and fails closed when empty', async () => {
  const { collectNpmPackages } = await import(new URL('./generate-image-sbom.mjs', import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'war-npm-inventory-'));
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'war-npm-inventory-empty-'));
  const writePackage = (relativePath, metadata) => {
    const packageDir = path.join(root, 'node_modules', ...relativePath.split('/'));
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), `${JSON.stringify(metadata)}\n`);
  };
  try {
    writePackage('playwright-core', { name: 'playwright-core', version: '1.61.1', license: 'Apache-2.0' });
    writePackage('ws', { name: 'ws', version: '8.21.1', license: 'MIT' });
    writePackage('ws/node_modules/helper', { name: 'helper', version: '1.0.0', license: 'ISC' });
    writePackage('@scope/pkg', { name: '@scope/pkg', version: '2.0.0', license: 'MIT' });
    writePackage('dev-only', { name: 'dev-only', version: '9.0.0', license: 'MIT' });
    fs.writeFileSync(path.join(root, 'package-lock.json'), `${JSON.stringify({
      packages: {
        'node_modules/playwright-core': { version: '1.61.1' },
        'node_modules/ws': { version: '8.21.1' },
        'node_modules/ws/node_modules/helper': { version: '1.0.0' },
        'node_modules/@scope/pkg': { version: '2.0.0' },
        'node_modules/dev-only': { version: '9.0.0', dev: true },
      },
    })}\n`);
    fs.mkdirSync(path.join(emptyRoot, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(emptyRoot, 'package-lock.json'), '{"packages":{}}\n');

    const inventory = collectNpmPackages({ root });
    assert.deepEqual(inventory.map(({ name, version }) => ({ name, version })), [
      { name: '@scope/pkg', version: '2.0.0' },
      { name: 'helper', version: '1.0.0' },
      { name: 'playwright-core', version: '1.61.1' },
      { name: 'ws', version: '8.21.1' },
    ]);
    assert.ok(inventory.every(({ installPath }) => installPath.startsWith('node_modules/')));
    writePackage('ws/node_modules/helper', { name: 'helper', version: '1.0.1', license: 'ISC' });
    assert.throws(() => collectNpmPackages({ root }), /does not match installed package/);
    assert.throws(() => collectNpmPackages({ root: emptyRoot }), /empty/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }
});
