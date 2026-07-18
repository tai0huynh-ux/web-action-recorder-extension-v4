import { validateWorkflowRevision } from '../../protocol/src/protocolV2.js';
import { createWorkflowContentHash } from '../../workflow-core/src/workflowMetadata.js';
import { domainError, ERROR_CODES } from './errors.js';

export class WorkflowRegistry {
  constructor({ store, audit, now }) {
    this.store = store;
    this.audit = audit;
    this.now = now;
  }

  putRevision(revision) {
    const validation = validateWorkflowRevision(revision);
    if (!validation.ok) throw domainError(ERROR_CODES.WORKFLOW_HASH_MISMATCH, 'WorkflowRevision is invalid', 400, validation.errors);
    if (createWorkflowContentHash(revision) !== revision.contentHash) throw domainError(ERROR_CODES.WORKFLOW_HASH_MISMATCH, 'WorkflowRevision contentHash does not match its payload', 400);
    if (containsSensitiveDefault(revision)) throw domainError(ERROR_CODES.WORKFLOW_HASH_MISMATCH, 'WorkflowRevision contains sensitive default input');
    return this.store.update((state) => {
      const existing = state.workflowRevisions.find((item) => item.workflowId === revision.workflowId && item.contentHash === revision.contentHash);
      if (existing) return { created: false, revision: structuredClone(existing) };
      const revisions = state.workflowRevisions.filter((item) => item.workflowId === revision.workflowId);
      const next = { ...structuredClone(revision), revision: revisions.length ? Math.max(...revisions.map((item) => item.revision)) + 1 : revision.revision };
      state.workflowRevisions.push(next);
      state.workflowRevisions.sort((a, b) => a.workflowId.localeCompare(b.workflowId) || a.revision - b.revision);
      this.audit.append(state, 'workflow.accepted', { workflowId: next.workflowId, revision: next.revision, sourceDeviceId: next.sourceDeviceId });
      return { created: true, revision: structuredClone(next) };
    });
  }

  getRevision(workflowId, revision) {
    const found = this.store.snapshot().workflowRevisions.find((item) => item.workflowId === workflowId && item.revision === revision);
    if (!found) throw domainError(ERROR_CODES.WORKFLOW_NOT_FOUND, 'Workflow not found', 404);
    return structuredClone(found);
  }

  listMetadata() {
    return this.store.snapshot().workflowRevisions
      .toSorted((a, b) => a.workflowId.localeCompare(b.workflowId) || a.revision - b.revision)
      .map(({ profilePayload: _profilePayload, ...metadata }) => metadata);
  }

  findByContentHash(workflowId, contentHash) {
    return structuredClone(this.store.snapshot().workflowRevisions.find((item) => item.workflowId === workflowId && item.contentHash === contentHash) || null);
  }
}

function containsSensitiveDefault(revision) {
  return (revision.requiredInputs || []).some((input) => input.sensitive && Object.prototype.hasOwnProperty.call(input, 'defaultValue'));
}
