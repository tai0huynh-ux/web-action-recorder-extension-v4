import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const entrypointUrl = new URL('../entrypoint.sh', import.meta.url);

test('uses role-specific processes and bounded X11 readiness before Sunshine starts', async () => {
  const entrypoint = await readFile(entrypointUrl, 'utf8');
  assert.match(entrypoint, /WAR_PILOT_ROLE must be chrome or sunshine/);
  assert.match(entrypoint, /for attempt in \{1\.\.100\}/);
  assert.match(entrypoint, /-S "\$socket_path"/);
  assert.match(entrypoint, /run_chrome\(\)[\s\S]*Xvfb/);
  assert.match(entrypoint, /run_sunshine\(\)[\s\S]*wait_for_display[\s\S]*"\$SUNSHINE_BIN"/);
  assert.match(entrypoint, /trap cleanup EXIT/);
  assert.doesNotMatch(entrypoint, /chmod 1777 "\$X11_SOCKET_DIR"/);
});

test('retains the no-sandbox compatibility switch and isolates Sunshine state', async () => {
  const entrypoint = await readFile(entrypointUrl, 'utf8');
  assert.match(entrypoint, /WAR_PILOT_NO_SANDBOX=1/);
  assert.match(entrypoint, /chrome_args\+=\(--no-sandbox\)/);
  assert.doesNotMatch(entrypoint, /export HOME=/);
  assert.doesNotMatch(entrypoint, /SUNSHINE_STATE_DIR/);
});
