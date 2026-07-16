import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const rendererRoot = path.resolve('platform/controller-electron/renderer');
const forbiddenJs = [
  /\binnerHTML\b/,
  /\bouterHTML\b/,
  /\binsertAdjacentHTML\b/,
  /\bdocument\.write\b/,
  /\bDOMParser\b/,
  /\beval\s*\(/,
  /\bnew\s+Function\b/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /\brequire\s*\(/,
  /\bprocess\b/,
  /\bBuffer\b/,
  /\bipcRenderer\b/,
  /\bshell\.openExternal\b/,
  /https?:\/\//,
];

test('production renderer scripts avoid privileged and injection-prone APIs', () => {
  for (const file of listFiles(rendererRoot, '.js')) {
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of forbiddenJs) {
      assert.equal(pattern.test(source), false, `${path.relative(rendererRoot, file)} contains ${pattern}`);
    }
  }
});

test('renderer document has no inline code or remote assets', () => {
  const source = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
  assert.equal(/<script(?![^>]+src=)[^>]*>/i.test(source), false);
  assert.equal(/\son[a-z]+\s*=/i.test(source), false);
  assert.equal(/\sstyle\s*=/i.test(source), false);
  assert.equal(/https?:\/\//i.test(source), false);
  assert.match(source, /<script type="module" src="\.\/app\.js"><\/script>/);
  assert.match(source, /<link rel="stylesheet" href="\.\/styles\.css">/);
});

test('renderer styles do not import remote assets', () => {
  for (const file of listFiles(rendererRoot, '.css')) {
    const source = fs.readFileSync(file, 'utf8');
    assert.equal(/https?:\/\//i.test(source), false);
    assert.equal(/@import/i.test(source), false);
  }
});

function listFiles(root, extension) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) return listFiles(full, extension);
    return entry.isFile() && full.endsWith(extension) ? [full] : [];
  });
}
