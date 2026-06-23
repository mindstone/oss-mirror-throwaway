/**
 * Attachment Temp Service
 *
 * Writes clipboard-pasted attachment binaries to temp files so the agent
 * can reference them by path (copy, move, etc.).
 *
 * Only used for attachments WITHOUT an originalPath (clipboard pastes).
 * Drag-dropped / file-picker files already have originalPath from the renderer.
 *
 * Temp location: userData/temp-attachments/{uuid}-{filename}
 * Cleanup: files older than 24h, run on app startup.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { createScopedLogger } from '@core/logger';
import { getDataPath } from '@core/utils/dataPaths';
import type { AnyAttachmentPayload } from '@shared/types';
import {
  isImageAttachment,
  isDocumentAttachment,
  isExtractedPdfAttachment,
  isOfficeDocumentAttachment,
  isTextFileAttachment,
  isBinaryFileAttachment,
  isTextAttachment,
} from '@shared/types';

const log = createScopedLogger({ service: 'attachmentTemp' });

const TEMP_DIR_NAME = 'temp-attachments';
const TEMP_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Get the temp attachments directory, creating it if needed.
 */
const getTempDir = (): string => {
  const tempDir = path.join(getDataPath(), TEMP_DIR_NAME);
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }
  return tempDir;
};

/**
 * Sanitize a filename for safe filesystem use.
 * Removes path separators and null bytes, replaces invalid characters.
 */
const sanitizeFilename = (name: string): string => {
  const sanitized = name
    .replace(/[/\\:*?"<>|\x00]/g, '_')
    .replace(/\.{2,}/g, '.')
    .slice(0, 200);
  return sanitized || 'attachment';
};

/**
 * Write a base64 string to a temp file. Returns the absolute path.
 */
const writeTempBase64 = async (base64Data: string, filename: string): Promise<string> => {
  const tempDir = getTempDir();
  const safeName = sanitizeFilename(filename);
  const tempPath = path.join(tempDir, `${randomUUID()}-${safeName}`);
  const buffer = Buffer.from(base64Data, 'base64');
  await fs.writeFile(tempPath, buffer);
  return tempPath;
};

/**
 * Write text content to a temp file. Returns the absolute path.
 */
const writeTempText = async (content: string, filename: string): Promise<string> => {
  const tempDir = getTempDir();
  const safeName = sanitizeFilename(filename);
  const tempPath = path.join(tempDir, `${randomUUID()}-${safeName}`);
  await fs.writeFile(tempPath, content, 'utf-8');
  return tempPath;
};

/**
 * Resolve the source path for an attachment.
 * - If originalPath exists: use it directly (file is on disk from drag-drop/picker)
 * - If base64Data exists: write to temp, return temp path
 * - If content exists (text files): write to temp, return temp path
 * - Returns undefined if no source can be determined
 */
export const resolveAttachmentSourcePath = async (
  attachment: AnyAttachmentPayload
): Promise<string | undefined> => {
  // AgentAttachmentPayload already has a path field — skip
  if (isTextAttachment(attachment)) {
    return attachment.path;
  }

  // Check for originalPath first (disk-backed files)
  if ('originalPath' in attachment && attachment.originalPath) {
    return attachment.originalPath;
  }

  try {
    // Image: base64Data always present
    if (isImageAttachment(attachment) && attachment.base64Data) {
      return await writeTempBase64(attachment.base64Data, attachment.name);
    }

    // PDF document: base64Data always present
    if (isDocumentAttachment(attachment) && attachment.base64Data) {
      return await writeTempBase64(attachment.base64Data, attachment.name);
    }

    // Extracted PDF (large): base64Data only for clipboard pastes
    if (isExtractedPdfAttachment(attachment) && attachment.base64Data) {
      return await writeTempBase64(attachment.base64Data, attachment.name);
    }

    // Office document: base64Data only for clipboard pastes
    if (isOfficeDocumentAttachment(attachment) && attachment.base64Data) {
      return await writeTempBase64(attachment.base64Data, attachment.name);
    }

    // Text file: has content string
    if (isTextFileAttachment(attachment)) {
      return await writeTempText(attachment.content, attachment.name);
    }

    // Binary file: base64Data only for clipboard pastes
    if (isBinaryFileAttachment(attachment) && attachment.base64Data) {
      return await writeTempBase64(attachment.base64Data, attachment.name);
    }
  } catch (error) {
    log.warn({ error, name: attachment.name ?? 'unknown' }, 'Failed to write temp attachment');
  }

  return undefined;
};

/**
 * Clean up temp attachment files older than TEMP_EXPIRY_MS.
 * Should be called on app startup.
 */
export const cleanupTempAttachments = async (): Promise<number> => {
  const tempDir = path.join(getDataPath(), TEMP_DIR_NAME);
  let deletedCount = 0;

  if (!existsSync(tempDir)) return 0;

  try {
    const files = await fs.readdir(tempDir);
    const now = Date.now();

    for (const file of files) {
      const filePath = path.join(tempDir, file);
      try {
        const stat = await fs.stat(filePath);
        if (now - stat.mtimeMs > TEMP_EXPIRY_MS) {
          await fs.unlink(filePath);
          deletedCount++;
        }
      } catch {
        // If we can't stat/delete, skip
      }
    }

    if (deletedCount > 0) {
      log.info({ deletedCount }, 'Cleaned up expired temp attachments');
    }
  } catch (error) {
    log.error({ error }, 'Failed to cleanup temp attachments');
  }

  return deletedCount;
};
