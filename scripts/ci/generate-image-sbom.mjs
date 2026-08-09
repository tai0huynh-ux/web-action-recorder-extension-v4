import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const IMAGE_NAME = 'web-action-recorder-browser-agent-image';
const SOURCE_URL = 'https://github.com/tai0huynh-ux/web-action-recorder-extension-v4';
const NODE_BASE_DIGEST = '6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3';
const CLOAKBROWSER_VERSION = '146.0.7680.177.5';
const CLOAKBROWSER_ARCHIVE_SHA256 = '4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e';
const CLOAKBROWSER_LICENSE_SHA256 = 'a959b6f9db58f7e273694368659140e9d82960d964ab48b5f6cf9c4545cc2981';
const XCLIP_COMMIT = '2c3b811002b35d3be7f39cc1145dd06bdb32e31c';
const XCLIP_ARCHIVE_SHA256 = '2bb193f5ac15872bc1b2579643bebf6303804b98e7b6bcc55ff2be9921843a4a';
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SOURCE_REVISION_PATTERN = /^[a-f0-9]{40}$/;

export async function generateImageSbom({
  sourceRevision,
  imageId,
  outputDir,
  created = new Date().toISOString(),
  baseRevision = sourceRevision,
  sourceRevisionType = 'git-commit',
  debianPackages = collectDebianPackages(),
  npmPackages = collectNpmPackages(),
} = {}) {
  requirePattern(sourceRevision, SOURCE_REVISION_PATTERN, 'sourceRevision');
  requirePattern(baseRevision, SOURCE_REVISION_PATTERN, 'baseRevision');
  requirePattern(imageId, IMAGE_ID_PATTERN, 'imageId');
  if (typeof outputDir !== 'string' || !outputDir.trim()) throw new Error('outputDir is required');
  if (!Number.isFinite(Date.parse(created))) throw new Error('created must be an ISO timestamp');
  if (!['git-commit', 'working-tree-diff'].includes(sourceRevisionType)) throw new Error('sourceRevisionType is invalid');

  const normalizedDebian = normalizeInventory(debianPackages, 'Debian');
  const normalizedNpm = normalizeInventory(npmPackages, 'npm');
  const sbom = buildSpdx({ sourceRevision, baseRevision, sourceRevisionType, imageId, created, debianPackages: normalizedDebian, npmPackages: normalizedNpm });
  const sbomBytes = Buffer.from(`${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
  const binding = {
    schemaVersion: 1,
    subject: { imageId },
    sourceRevision,
    baseRevision,
    sourceRevisionType,
    sbom: {
      path: 'SBOM.spdx.json',
      sha256: sha256(sbomBytes),
      format: 'spdx-json',
      version: '2.3',
    },
  };

  await fsp.mkdir(outputDir, { recursive: true });
  const sbomPath = path.join(outputDir, 'SBOM.spdx.json');
  const bindingPath = path.join(outputDir, 'SBOM.image-binding.json');
  await fsp.writeFile(sbomPath, sbomBytes);
  await fsp.writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`, 'utf8');
  return { sbomPath, bindingPath, sbom, binding };
}

export function collectDebianPackages() {
  const output = execFileSync('dpkg-query', ['-W', '-f=${binary:Package}\t${Version}\t${Architecture}\n'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  const packages = output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, version, architecture] = line.split('\t');
    if (!name || !version || !architecture) throw new Error('dpkg package inventory entry is invalid');
    return {
      name,
      version,
      architecture,
      purl: `pkg:deb/debian/${purlPart(name)}@${purlPart(version)}?arch=${purlPart(architecture)}`,
    };
  });
  if (!packages.length) throw new Error('dpkg package inventory is empty');
  return packages;
}

export function collectNpmPackages({ root = process.cwd(), fsImpl = fs } = {}) {
  const nodeModules = path.join(root, 'node_modules');
  const lockPath = path.join(root, 'package-lock.json');
  requireRealDirectory(fsImpl, nodeModules, 'npm node_modules');
  const lockStat = fsImpl.lstatSync(lockPath);
  if (lockStat.isSymbolicLink() || !lockStat.isFile()) throw new Error('npm package-lock.json must be a regular file');
  const lockPackages = JSON.parse(fsImpl.readFileSync(lockPath, 'utf8')).packages;
  if (!lockPackages || typeof lockPackages !== 'object') throw new Error('npm package-lock inventory is invalid');
  const packages = [];
  visitNpmDirectory(fsImpl, root, nodeModules, lockPackages, packages);
  if (!packages.length) throw new Error('npm package inventory is empty');
  return packages.sort((left, right) => (
    left.name.localeCompare(right.name)
    || left.version.localeCompare(right.version)
    || left.installPath.localeCompare(right.installPath)
  ));
}

function visitNpmDirectory(fsImpl, root, nodeModules, lockPackages, packages) {
  const entries = fsImpl.readdirSync(nodeModules, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) throw new Error(`npm package inventory rejects symlink: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(nodeModules, entry.name);
    if (entry.name.startsWith('@')) {
      const scopedEntries = fsImpl.readdirSync(entryPath, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const scopedEntry of scopedEntries) {
        if (scopedEntry.isSymbolicLink() || !scopedEntry.isDirectory()) {
          throw new Error(`npm scoped package inventory entry is invalid: ${entry.name}/${scopedEntry.name}`);
        }
        visitNpmPackage(fsImpl, root, path.join(entryPath, scopedEntry.name), lockPackages, packages);
      }
      continue;
    }
    visitNpmPackage(fsImpl, root, entryPath, lockPackages, packages);
  }
}

function visitNpmPackage(fsImpl, root, packageDir, lockPackages, packages) {
  requireRealDirectory(fsImpl, packageDir, 'npm package');
  const packageJsonPath = path.join(packageDir, 'package.json');
  const packageJsonStat = fsImpl.lstatSync(packageJsonPath);
  if (packageJsonStat.isSymbolicLink() || !packageJsonStat.isFile()) throw new Error('npm package.json must be a regular file');
  const metadata = JSON.parse(fsImpl.readFileSync(packageJsonPath, 'utf8'));
  if (typeof metadata.name !== 'string' || !metadata.name || typeof metadata.version !== 'string' || !metadata.version) {
    throw new Error('npm package inventory entry is invalid');
  }
  const installPath = path.relative(root, packageDir).split(path.sep).join('/');
  const lockMetadata = lockPackages[installPath];
  if (!lockMetadata || lockMetadata.version !== metadata.version) throw new Error(`npm package-lock does not match installed package: ${installPath}`);
  if (lockMetadata.dev === true) return;
  packages.push({
    name: metadata.name,
    version: metadata.version,
    license: normalizeLicense(metadata.license),
    downloadLocation: 'NOASSERTION',
    installPath,
    purl: `pkg:npm/${purlPart(metadata.name)}@${purlPart(metadata.version)}`,
  });

  const nestedNodeModules = path.join(packageDir, 'node_modules');
  const nestedStat = lstatIfExists(fsImpl, nestedNodeModules);
  if (!nestedStat) return;
  if (nestedStat.isSymbolicLink() || !nestedStat.isDirectory()) throw new Error('nested npm node_modules must be a real directory');
  visitNpmDirectory(fsImpl, root, nestedNodeModules, lockPackages, packages);
}

function requireRealDirectory(fsImpl, target, label) {
  const stat = fsImpl.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a real directory`);
}

function lstatIfExists(fsImpl, target) {
  try {
    return fsImpl.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function buildSpdx({ sourceRevision, baseRevision, sourceRevisionType, imageId, created, debianPackages, npmPackages }) {
  const imagePackage = packageEntry({
    name: IMAGE_NAME,
    id: 'Image',
    version: sourceRevision,
    downloadLocation: 'NOASSERTION',
    sourceInfo: `git+${SOURCE_URL}.git@${baseRevision}; sourceRevision=${sourceRevision}; sourceRevisionType=${sourceRevisionType}; immutable local image ${imageId}`,
    checksum: imageId.slice('sha256:'.length),
  });
  const debianSummary = packageEntry({
    name: 'debian-bookworm-packages',
    id: 'Debian-Summary',
    version: 'bookworm',
    purl: 'pkg:deb/debian/base-files@bookworm',
    comment: `${debianPackages.length} installed dpkg packages are enumerated as SPDX packages.`,
  });
  const npmSummary = packageEntry({
    name: 'browser-agent-npm-dependencies',
    id: 'Npm-Summary',
    version: 'production',
    purl: 'pkg:npm/playwright-core@1.61.1',
    comment: `${npmPackages.length} installed production npm packages are enumerated as SPDX packages.`,
  });
  const nodeBase = packageEntry({
    name: 'node:22-bookworm-slim',
    id: 'Node-Base',
    version: '22-bookworm-slim',
    downloadLocation: 'https://hub.docker.com/_/node',
    checksum: NODE_BASE_DIGEST,
    purl: `pkg:docker/node@${NODE_BASE_DIGEST}?tag=22-bookworm-slim`,
  });
  const cloakbrowser = packageEntry({
    name: 'cloakbrowser',
    id: 'CloakBrowser',
    version: CLOAKBROWSER_VERSION,
    downloadLocation: 'https://github.com/CloakHQ/CloakBrowser/releases',
    checksum: CLOAKBROWSER_ARCHIVE_SHA256,
    license: 'LicenseRef-CloakBrowser',
    purl: `pkg:generic/cloakbrowser@${CLOAKBROWSER_VERSION}?checksum=sha256:${CLOAKBROWSER_ARCHIVE_SHA256}`,
    comment: 'The build verifies the vendor-signed manifest and the pinned archive SHA-256 before copying the unmodified binary into the image.',
  });
  const cloakWrapper = packageEntry({
    name: 'cloakbrowser-wrapper',
    id: 'CloakBrowser-Wrapper',
    version: '0.5.5',
    downloadLocation: 'https://www.npmjs.com/package/cloakbrowser',
    license: 'MIT',
    purl: 'pkg:npm/cloakbrowser@0.5.5',
    comment: 'Build-stage dependency only; it downloads and verifies the pinned browser binary and is absent from the final runtime node_modules.',
  });
  const xclip = packageEntry({
    name: 'xclip-sensitive',
    id: 'Xclip-Sensitive',
    version: XCLIP_COMMIT,
    downloadLocation: `https://github.com/astrand/xclip/archive/${XCLIP_COMMIT}.tar.gz`,
    checksum: XCLIP_ARCHIVE_SHA256,
    license: 'GPL-2.0-or-later',
    purl: `pkg:github/astrand/xclip@${XCLIP_COMMIT}`,
  });
  const nodeRuntime = packageEntry({
    name: 'node-runtime',
    id: 'Node-Runtime',
    version: process.versions.node,
    downloadLocation: 'https://nodejs.org/',
    license: 'MIT',
    purl: `pkg:generic/node@${purlPart(process.versions.node)}`,
  });
  const debianEntries = debianPackages.map((entry, index) => packageEntry({
    name: entry.name,
    id: `Debian-${index}-${entry.name}`,
    version: entry.version,
    purl: entry.purl,
    license: entry.license,
    comment: entry.architecture ? `Architecture: ${entry.architecture}` : undefined,
  }));
  const npmEntries = npmPackages.map((entry, index) => packageEntry({
    name: entry.name,
    id: `Npm-${index}-${entry.name}`,
    version: entry.version,
    downloadLocation: entry.downloadLocation,
    purl: entry.purl,
    license: entry.license,
    comment: entry.installPath ? `Installed dependency path: ${entry.installPath}` : undefined,
  }));
  const components = [debianSummary, npmSummary, nodeBase, cloakbrowser, cloakWrapper, xclip, nodeRuntime, ...debianEntries, ...npmEntries];
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${IMAGE_NAME}-${sourceRevision}`,
    documentNamespace: `https://web-action-recorder.invalid/spdx/browser-agent/${sourceRevision}/${imageId.slice(7, 23)}`,
    creationInfo: {
      creators: ['Tool: Web Action Recorder image SBOM generator'],
      created,
    },
    hasExtractedLicensingInfos: [{
      licenseId: 'LicenseRef-CloakBrowser',
      extractedText: 'CloakBrowser Binary License Version 1.3 permits internal use of the unmodified binary, including internally controlled Docker images, and prohibits redistribution without a separate agreement.',
      seeAlsos: ['https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md'],
      comment: `Official license text SHA-256: ${CLOAKBROWSER_LICENSE_SHA256}`,
    }],
    packages: [imagePackage, ...components],
    relationships: [
      { spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: imagePackage.SPDXID },
      ...components.map((component) => ({ spdxElementId: imagePackage.SPDXID, relationshipType: 'CONTAINS', relatedSpdxElement: component.SPDXID })),
      { spdxElementId: cloakWrapper.SPDXID, relationshipType: 'BUILD_DEPENDENCY_OF', relatedSpdxElement: imagePackage.SPDXID },
    ],
  };
}

function packageEntry({ name, id, version, downloadLocation = 'NOASSERTION', sourceInfo, checksum, license = 'NOASSERTION', purl, comment }) {
  return {
    name,
    SPDXID: `SPDXRef-Package-${spdxId(id)}`,
    versionInfo: version || 'NOASSERTION',
    downloadLocation,
    filesAnalyzed: false,
    licenseConcluded: license,
    licenseDeclared: license,
    copyrightText: 'NOASSERTION',
    ...(sourceInfo ? { sourceInfo } : {}),
    ...(checksum ? { checksums: [{ algorithm: 'SHA256', checksumValue: checksum }] } : {}),
    ...(purl ? { externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: purl }] } : {}),
    ...(comment ? { comment } : {}),
  };
}

function normalizeInventory(entries, label) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`${label} package inventory is empty`);
  return entries.map((entry) => {
    if (!entry || typeof entry.name !== 'string' || !entry.name || typeof entry.version !== 'string' || !entry.version) {
      throw new Error(`${label} package inventory entry is invalid`);
    }
    return { ...entry };
  });
}

function normalizeLicense(value) {
  return typeof value === 'string' && /^[A-Za-z0-9.+()-]+$/.test(value) ? value : 'NOASSERTION';
}

function purlPart(value) {
  return encodeURIComponent(String(value)).replace(/%2F/gi, '/');
}

function spdxId(value) {
  return String(value).replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'Unknown';
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function requirePattern(value, pattern, name) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${name} is invalid`);
}

function parseCli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid CLI argument: ${key || '<missing>'}`);
    values[key.slice(2)] = value;
  }
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseCli(process.argv.slice(2));
  generateImageSbom({
    sourceRevision: args['source-revision'],
    baseRevision: args['base-revision'],
    sourceRevisionType: args['source-revision-type'],
    imageId: args['image-id'],
    outputDir: args['output-dir'],
    created: args.created,
  }).then((result) => {
    process.stdout.write(`${JSON.stringify({ sbomPath: result.sbomPath, bindingPath: result.bindingPath })}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
