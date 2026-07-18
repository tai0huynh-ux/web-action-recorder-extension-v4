import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const UPSTREAM_COMMIT = '3c28324314729dbade8287e868eef6338c42807a';
const UPSTREAM_SHA256 = '536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74';
const UPSTREAM_URL = `https://raw.githubusercontent.com/moby/profiles/${UPSTREAM_COMMIT}/seccomp/default.json`;
const OUTPUT = path.resolve('platform/container/security/chromium-userns-seccomp.json');
const NAMESPACE_MASK = 0x7e020000;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generate().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

export async function generate() {
  const response = await fetch(UPSTREAM_URL);
  if (!response.ok) throw new Error(`Failed to fetch pinned Moby seccomp profile: ${response.status}`);
  const source = await response.text();
  if (sha256(source) !== UPSTREAM_SHA256) throw new Error('Pinned Moby seccomp profile integrity check failed');
  const profile = JSON.parse(source);
  profile.syscalls.push(
    cloneRule(0x10000000, 'Allow Chromium to probe and create its user namespace only.'),
    cloneRule(0x20000000, 'Allow Chromium to fork inside its PID namespace only.'),
    cloneRule(0x70000000, 'Allow Chromium combined user, PID, and network namespace launch only.'),
    {
      names: ['unshare'],
      action: 'SCMP_ACT_ALLOW',
      args: [{ index: 0, value: NAMESPACE_MASK, valueTwo: 0x10000000, op: 'SCMP_CMP_MASKED_EQ' }],
      comment: 'Allow Chromium to verify and enter a user namespace only.',
    },
  );
  const serialized = `${JSON.stringify(profile, null, 2)}\n`;
  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, serialized);
  console.log(JSON.stringify({ output: OUTPUT, sha256: sha256(serialized), upstreamCommit: UPSTREAM_COMMIT }, null, 2));
}

function cloneRule(flags, comment) {
  return {
    names: ['clone'],
    action: 'SCMP_ACT_ALLOW',
    args: [{ index: 0, value: NAMESPACE_MASK, valueTwo: flags, op: 'SCMP_CMP_MASKED_EQ' }],
    comment,
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
