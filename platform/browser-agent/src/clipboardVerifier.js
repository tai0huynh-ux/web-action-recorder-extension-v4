import { execFile, spawn } from 'node:child_process';
import { AgentError } from './errors.js';

const XCLIP = '/usr/bin/xclip';
const SENSITIVE_XCLIP = '/usr/local/bin/war-xclip-sensitive';
const READ_ARGS = Object.freeze(['-selection', 'clipboard', '-o']);
const PRIMARY_ARGS = Object.freeze(['-selection', 'primary', '-o']);
const SENSITIVE_WRITE_ARGS = Object.freeze(['-selection', 'clipboard', '-in', '-quiet', '-sensitive', '-wait', '250']);
const MAX_CLIPBOARD_BYTES = 64 * 1024;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const READY_MESSAGE = /waiting for selection requests/i;
const DEFAULT_KILL_GRACE_MS = 250;

// A SIGKILL request does not prove that a child exited. Do not hand clipboard
// ownership to another helper until the previous process reports close.
let clipboardOwnerQuarantine;

export function readX11Clipboard({ selection = 'clipboard', timeoutMs = 1000, maxBytes = 4096, env = process.env, execFileImpl = execFile } = {}) {
  const args = selection === 'primary' ? PRIMARY_ARGS : selection === 'clipboard' ? READ_ARGS : null;
  if (!args) return Promise.reject(new AgentError('CLIPBOARD_VERIFY_FAILED', 'Unsupported X11 selection'));
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CLIPBOARD_BYTES) {
    return Promise.reject(new AgentError('CLIPBOARD_VERIFY_FAILED', 'X11 clipboard limit is invalid'));
  }
  return new Promise((resolve, reject) => {
    const child = execFileImpl(XCLIP, args, {
      env: { DISPLAY: env.DISPLAY || ':99' },
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: maxBytes + 1,
      encoding: 'buffer'
    }, (error, stdout = Buffer.alloc(0)) => {
      if (error) {
        if (error.killed || error.signal === 'SIGTERM') return reject(new AgentError('CLIPBOARD_VERIFY_FAILED', 'X11 clipboard read timed out'));
        return reject(new AgentError('CLIPBOARD_VERIFY_FAILED', 'X11 clipboard read failed'));
      }
      const output = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, 'utf8');
      if (output.length > maxBytes) return reject(new AgentError('CLIPBOARD_VERIFY_FAILED', 'X11 clipboard output exceeded limit'));
      try {
        resolve(utf8Decoder.decode(output));
      } catch {
        reject(new AgentError('CLIPBOARD_VERIFY_FAILED', 'X11 clipboard is not valid UTF-8'));
      }
    });
    child?.stdin?.end?.();
  });
}

// The helper remains the X11 selection owner only until the browser asks for it.
// Killing it therefore removes the sensitive selection instead of overwriting it.
export async function startX11ClipboardPaste(text, {
  deadlineAt,
  now = () => Date.now(),
  timeoutMs = 5000,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  env = process.env,
  spawnImpl = spawn
} = {}) {
  if (clipboardOwnerQuarantine) {
    throw new AgentError('CLIPBOARD_WRITE_FAILED', 'Previous X11 clipboard helper is still settling');
  }
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_BYTES) {
    return Promise.reject(new AgentError('CLIPBOARD_WRITE_FAILED', 'X11 clipboard text exceeds the 64 KiB limit'));
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  const remainingMs = deadlineAt === undefined ? timeoutMs : deadlineAt - now();
  const boundedTimeoutMs = Math.min(timeoutMs, remainingMs);
  const deadlineLimitsSession = deadlineAt !== undefined && remainingMs <= timeoutMs;
  if (!Number.isFinite(boundedTimeoutMs) || boundedTimeoutMs < 1) {
    throw new AgentError('deadline_exceeded', 'Command deadline has already passed', 408);
  }

  let child;
  try {
    child = spawnImpl(SENSITIVE_XCLIP, SENSITIVE_WRITE_ARGS, {
      env: { DISPLAY: env.DISPLAY || ':99' },
      stdio: ['pipe', 'ignore', 'pipe']
    });
  } catch {
    throw new AgentError('CLIPBOARD_WRITE_FAILED', 'X11 clipboard helper could not start');
  }
  if (!child?.stdin || !child?.stderr || typeof child.once !== 'function') {
    terminateClipboardChild(child);
    throw new AgentError('CLIPBOARD_WRITE_FAILED', 'X11 clipboard helper could not start');
  }

  let ready = false;
  let pasteRequested = false;
  let exited = false;
  let terminated = false;
  let readySettled = false;
  let completionSettled = false;
  let readinessStderr = Buffer.alloc(0);
  let readyResolve;
  let readyReject;
  let completionResolve;
  let completionReject;
  const readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const completionPromise = new Promise((resolve, reject) => { completionResolve = resolve; completionReject = reject; });
  // Startup can fail before a caller obtains the session.
  completionPromise.catch(() => {});
  let deadlineTimer;
  let killTimer;

  const settleReadyFailure = (error) => {
    if (readySettled) return;
    readySettled = true;
    readyReject(error);
  };
  const settleCompletionFailure = (error) => {
    if (completionSettled) return;
    completionSettled = true;
    completionReject(error);
  };
  const settleCompletionSuccess = () => {
    if (completionSettled) return;
    completionSettled = true;
    completionResolve({ written: true, bytes });
  };
  const closeError = (message = 'X11 clipboard helper did not become ready') => new AgentError(
    'CLIPBOARD_WRITE_FAILED',
    message
  );
  const deadlineError = () => new AgentError('deadline_exceeded', 'Command deadline has already passed', 408);
  const forceTerminate = (error) => {
    if (terminated || exited) return;
    terminated = true;
    clipboardOwnerQuarantine = child;
    try { child.kill('SIGTERM'); } catch { /* The bounded settlement below still completes. */ }
    killTimer = setTimeout(() => {
      if (exited) return;
      try { child.kill('SIGKILL'); } catch { /* Best effort only. */ }
      settleReadyFailure(error);
      settleCompletionFailure(error);
    }, Math.max(1, killGraceMs));
  };
  deadlineTimer = setTimeout(() => {
    forceTerminate(deadlineLimitsSession ? deadlineError() : closeError('X11 clipboard helper timed out'));
  }, boundedTimeoutMs);

  child.once('error', () => {
    clearTimeout(deadlineTimer);
    readinessStderr = Buffer.alloc(0);
    const error = closeError('X11 clipboard helper failed');
    settleReadyFailure(error);
    settleCompletionFailure(error);
  });
  child.stderr.on('data', (chunk) => {
    // xclip -quiet documents this readiness line. Retain at most 1 KiB solely
    // to handle a line split across stream chunks; never log the stream.
    readinessStderr = appendBoundedStderr(readinessStderr, Buffer.from(chunk));
    if (!ready && READY_MESSAGE.test(readinessStderr.toString('utf8'))) {
      ready = true;
      readySettled = true;
      readinessStderr = Buffer.alloc(0);
      readyResolve();
    }
  });
  child.once('close', (code, signal) => {
    clearTimeout(deadlineTimer);
    clearTimeout(killTimer);
    readinessStderr = Buffer.alloc(0);
    exited = true;
    if (clipboardOwnerQuarantine === child) clipboardOwnerQuarantine = undefined;
    if (!ready) settleReadyFailure(closeError());
    if (terminated || code !== 0 || signal || !pasteRequested) {
      settleCompletionFailure(closeError(terminated ? 'X11 clipboard paste was cancelled' : 'X11 clipboard helper exited before paste completed'));
    } else {
      settleCompletionSuccess();
    }
  });

  child.stdin.once('error', () => {
    forceTerminate(closeError('X11 clipboard helper input failed'));
  });
  child.stdin.end(text);
  await readyPromise;

  return {
    bytes,
    async waitForPaste() {
      if (exited && !completionSettled) {
        throw new AgentError('CLIPBOARD_WRITE_FAILED', 'X11 clipboard helper exited before paste completed');
      }
      pasteRequested = true;
      return completionPromise;
    },
    async abort() {
      forceTerminate(closeError('X11 clipboard paste was cancelled'));
      await completionPromise.catch(() => {});
    }
  };
}

// Kept as a named compatibility export for callers migrating to the session API.
export const writeX11Clipboard = startX11ClipboardPaste;

function terminateClipboardChild(child) {
  try { child?.stdin?.destroy?.(); } catch { /* Best-effort process cleanup. */ }
  try { child?.kill?.('SIGTERM'); } catch { /* Best-effort process cleanup. */ }
}

function appendBoundedStderr(previous, chunk) {
  if (chunk.length >= 1024) return Buffer.from(chunk.subarray(-1024));
  const retained = previous.subarray(Math.max(0, previous.length + chunk.length - 1024));
  return Buffer.concat([retained, chunk]);
}

export async function compareX11Clipboard(expected, options = {}) {
  if (typeof expected !== 'string') throw new AgentError('CLIPBOARD_VERIFY_FAILED', 'Expected clipboard value must be a string');
  const value = await readX11Clipboard(options);
  return {
    copied: value.length > 0,
    expectedValueMatched: value === expected
  };
}
