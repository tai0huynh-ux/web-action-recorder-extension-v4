import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { AgentError } from './errors.js';

export class ScreenshotController {
  constructor({ artifactsDir = '/data/artifacts/screenshots', maxBytes = 5 * 1024 * 1024 } = {}) {
    this.artifactsDir = artifactsDir;
    this.maxBytes = maxBytes;
  }

  async capture(page, options = {}) {
    const format = options.format === 'jpeg' ? 'jpeg' : 'png';
    const quality = format === 'jpeg' && options.quality !== undefined ? validateQuality(options.quality) : undefined;
    const buffer = await page.screenshot({ type: format, quality, fullPage: false });
    if (buffer.length > this.maxBytes) throw new AgentError('screenshot_too_large', 'Screenshot exceeds configured size limit', 413);
    await fs.mkdir(this.artifactsDir, { recursive: true });
    const artifactId = `screenshot-${Date.now()}-${crypto.randomUUID()}.${format}`;
    const filePath = path.join(this.artifactsDir, artifactId);
    await fs.writeFile(filePath, buffer);
    return { artifactId, path: filePath, bytes: buffer.length, format };
  }
}

function validateQuality(value) {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new AgentError('invalid_payload', 'quality must be 1..100');
  return value;
}
