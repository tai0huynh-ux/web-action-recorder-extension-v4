import fs from 'node:fs';
import path from 'node:path';
import { validateWorkflowRevision } from '../../protocol/src/protocolV2.js';
import { createWorkflowContentHash } from '../../workflow-core/src/workflowMetadata.js';

export class WorkflowRegistry {
  constructor({ filePath, maxCount = 1000, maxPayloadBytes = 1024 * 1024, log = () => {} }) {
    this.filePath = filePath;
    this.maxCount = maxCount;
    this.maxPayloadBytes = maxPayloadBytes;
    this.log = log;
    this.state = { workflows: {} };
    this.load();
  }

  load() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      this.state = JSON.parse(raw);
      if (!this.state || typeof this.state !== 'object' || !this.state.workflows) this.state = { workflows: {} };
    } catch (error) {
      const recoveryPath = `${this.filePath}.corrupt-${Date.now()}`;
      fs.renameSync(this.filePath, recoveryPath);
      this.log('warn', 'workflowRegistry', 'corrupt_registry_recovered', { recoveryPath, message: error.message });
      this.state = { workflows: {} };
    }
  }

  putRevision(revision) {
    assertPayloadSize(revision, this.maxPayloadBytes);
    const validation = validateWorkflowRevision(revision);
    if (!validation.ok) {
      const error = new Error('WorkflowRevision is invalid.');
      error.details = validation.errors;
      throw error;
    }
    if (createWorkflowContentHash(revision) !== revision.contentHash) throw new Error('WorkflowRevision contentHash does not match its payload.');
    const workflowId = revision.workflowId;
    const existingByHash = this.findByContentHash(workflowId, revision.contentHash);
    if (existingByHash) return { created: false, revision: existingByHash };
    const revisions = this.state.workflows[workflowId] || [];
    if (this.countRevisions() >= this.maxCount) throw new Error('Workflow registry max count exceeded.');
    const nextRevisionNumber = revisions.length ? Math.max(...revisions.map((item) => item.revision)) + 1 : 1;
    const stored = { ...revision, revision: nextRevisionNumber };
    this.state.workflows[workflowId] = [...revisions, stored].sort(compareRevision);
    this.persist();
    return { created: true, revision: stored };
  }

  getRevision(workflowId, revision) {
    return (this.state.workflows[workflowId] || []).find((item) => item.revision === revision) || null;
  }

  listMetadata() {
    return Object.values(this.state.workflows)
      .flat()
      .sort((a, b) => a.workflowId.localeCompare(b.workflowId) || a.revision - b.revision)
      .map(({ profilePayload, ...metadata }) => metadata);
  }

  findByContentHash(workflowId, contentHash) {
    return (this.state.workflows[workflowId] || []).find((item) => item.contentHash === contentHash) || null;
  }

  findByWorkflowAndRevision(workflowId, revision) {
    return this.getRevision(workflowId, revision);
  }

  countRevisions() {
    return Object.values(this.state.workflows).reduce((total, revisions) => total + revisions.length, 0);
  }

  persist() {
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, this.filePath);
  }
}

export function createWorkflowRegistry(config, log) {
  return new WorkflowRegistry({
    filePath: path.join(config.paths.workflowDir, 'registry.json'),
    maxCount: config.workflowRegistryMaxCount,
    maxPayloadBytes: config.workflowRegistryMaxPayloadBytes,
    log
  });
}

function compareRevision(a, b) {
  return a.revision - b.revision || a.contentHash.localeCompare(b.contentHash);
}

function assertPayloadSize(value, maxBytes) {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > maxBytes) throw new Error(`Workflow payload exceeds ${maxBytes} bytes.`);
}
