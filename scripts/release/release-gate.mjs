import { execFileP, rootPath, writeJson } from './release-utils.mjs';

const results = [];
for (const [name, args] of [
  ['release integrity', ['run', 'test:release:integrity']],
  ['packaged controller', ['run', 'test:controller-electron:packaged']]
]) {
  const start = Date.now();
  try {
    await execFileP('npm.cmd', args);
    results.push({ name, pass: true, durationMs: Date.now() - start });
  } catch (error) {
    results.push({ name, pass: false, durationMs: Date.now() - start, error: String(error?.message || error) });
  }
}
await writeJson(rootPath('artifacts', 'release-packaging', `release-gate-${Date.now()}.json`), {
  timestamp: new Date().toISOString(),
  results,
  productionSignature: process.env.WAR_WINDOWS_SIGN_CERT_PATH ? 'CONFIGURED' : 'NOT_RUN_NO_CERTIFICATE'
});
if (results.some((item) => !item.pass)) throw new Error('release gate failed');
console.log(JSON.stringify({ result: 'PASS', results }, null, 2));
