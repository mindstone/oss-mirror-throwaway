/**
 * Hash Utilities
 *
 * Shared hashing functions for content integrity verification.
 * Used by both CoS pending staging and memory write conflict detection.
 */

import fs from 'node:fs/promises';
import crypto from 'node:crypto';

/**
 * Hash string content using SHA-256.
 */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Hash a file's contents using SHA-256.
 * Returns null if the file doesn't exist or can't be read.
 */
export async function hashFile(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return hashContent(content);
  } catch {
    return null;
  }
}
