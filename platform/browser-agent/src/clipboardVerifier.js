import { execFile } from 'node:child_process';
import { AgentError } from './errors.js';

const XCLIP = '/usr/bin/xclip';
const READ_ARGS = Object.freeze(['-selection', 'clipboard', '-o']);
const PRIMARY_ARGS = Object.freeze(['-selection', 'primary', '-o']);

export function readX11Clipboard({ selection = 'clipboard', timeoutMs = 1000, maxBytes = 4096, env = process.env, execFileImpl = execFile } = {}) {
  const args = selection === 'primary' ? PRIMARY_ARGS : selection === 'clipboard' ? READ_ARGS : null;
  if (!args) return Promise.reject(new AgentError('CLIPBOARD_VERIFY_FAILED', 'Unsupported X11 selection'));
  return new Promise((resolve, reject) => {
    const child = execFileImpl(XCLIP, args, {
      env: { DISPLAY: env.DISPLAY || ':99' },
      timeout: timeoutMs,
      maxBuffer: maxBytes
    }, (error, stdout = '') => {
      if (error) {
        if (error.killed || error.signal === 'SIGTERM') return reject(new AgentError('CLIPBOARD_VERIFY_FAILED', 'X11 clipboard read timed out'));
        return reject(new AgentError('CLIPBOARD_VERIFY_FAILED', 'X11 clipboard read failed'));
      }
      if (Buffer.byteLength(stdout, 'utf8') > maxBytes) return reject(new AgentError('CLIPBOARD_VERIFY_FAILED', 'X11 clipboard output exceeded limit'));
      resolve(stdout);
    });
    child?.stdin?.end?.();
  });
}

export async function compareX11Clipboard(expected, options = {}) {
  if (typeof expected !== 'string') throw new AgentError('CLIPBOARD_VERIFY_FAILED', 'Expected clipboard value must be a string');
  const value = await readX11Clipboard(options);
  return {
    copied: value.length > 0,
    expectedValueMatched: value === expected
  };
}
