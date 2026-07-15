import fs from 'node:fs/promises';
import path from 'node:path';
import { AgentError } from './errors.js';
import { requireString } from './inputSafety.js';

export class ArtifactRegistry {
  constructor({ uploadsDir = '/data/uploads' } = {}) {
    this.uploadsDir = path.resolve(uploadsDir);
  }

  async resolveUpload(artifactId) {
    requireString(artifactId, 'artifactId', { max: 255 });
    if (artifactId.includes('/') || artifactId.includes('\\') || artifactId.includes('..')) {
      throw new AgentError('invalid_artifact', 'artifactId is invalid');
    }
    const candidate = path.resolve(this.uploadsDir, artifactId);
    const realBase = await fs.realpath(this.uploadsDir);
    const realPath = await fs.realpath(candidate).catch(() => {
      throw new AgentError('artifact_not_found', 'Upload artifact was not found', 404);
    });
    if (realPath !== realBase && !realPath.startsWith(`${realBase}${path.sep}`)) {
      throw new AgentError('invalid_artifact', 'Upload artifact escapes allowlist');
    }
    return realPath;
  }
}
