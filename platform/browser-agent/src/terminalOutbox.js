import fs from 'node:fs';
import path from 'node:path';

const TERMINAL_TYPES = new Set(['execution.result', 'execution.cancelled']);

export class TerminalOutbox {
  constructor({ filePath, maxCount = 1024, maxEntryBytes = 256 * 1024, maxTotalBytes = 5 * 1024 * 1024, log = () => {} } = {}) {
    this.filePath = filePath;
    this.maxCount = maxCount;
    this.maxEntryBytes = maxEntryBytes;
    this.maxTotalBytes = maxTotalBytes;
    this.log = log;
    this.state = { entries: [] };
    this.load();
  }

  load() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.state.entries = Array.isArray(parsed?.entries) ? parsed.entries.filter((item) => item?.key && TERMINAL_TYPES.has(item.envelope?.type)) : [];
    } catch (error) {
      const recoveryPath = `${this.filePath}.corrupt-${Date.now()}`;
      fs.renameSync(this.filePath, recoveryPath);
      this.log('warn', 'terminalOutbox', 'corrupt_outbox_recovered', { recoveryPath, message: error.message });
      this.state = { entries: [] };
    }
  }

  put(envelope) {
    if (!TERMINAL_TYPES.has(envelope?.type) || !envelope?.jobId) throw new Error('Terminal outbox requires a terminal execution envelope.');
    const key = terminalKey(envelope);
    const existing = this.state.entries.find((item) => item.key === key);
    if (existing) return existing;
    if (this.state.entries.length >= this.maxCount) throw new Error('Terminal outbox limit exceeded.');
    const entry = { key, jobId: envelope.jobId, envelope: structuredClone(envelope) };
    if (encodedBytes(entry) > this.maxEntryBytes) throw new Error('Terminal outbox entry is too large.');
    if (encodedBytes({ entries: [...this.state.entries, entry] }) > this.maxTotalBytes) throw new Error('Terminal outbox storage limit exceeded.');
    this.state.entries.push(entry);
    this.persist();
    return entry;
  }

  acknowledge(key) {
    const next = this.state.entries.filter((item) => item.key !== key);
    if (next.length === this.state.entries.length) return false;
    this.state.entries = next;
    this.persist();
    return true;
  }

  hasJob(jobId) {
    return this.state.entries.some((item) => item.jobId === jobId);
  }

  list() {
    return this.state.entries.map((item) => structuredClone(item));
  }

  persist() {
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, this.filePath);
  }
}

export function terminalKey(envelope) {
  return envelope.idempotencyKey || `${envelope.jobId}:${envelope.type}:${envelope.payload?.eventType || ''}`;
}

function encodedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
