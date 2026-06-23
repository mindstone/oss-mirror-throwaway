/**
 * Attachment Cache Service
 *
 * Caches attachment payloads to disk for network reconnect resume.
 * When a turn fails due to transient network error, attachments are cached
 * so they can be restored when the network returns.
 *
 * Cache location: userData/attachment-cache/{uuid}.json
 * Expiry: 7 days (cleaned up on app startup)
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { createScopedLogger } from '@core/logger';
import { getDataPath } from '@core/utils/dataPaths';
import type { AnyAttachmentPayload } from '@shared/types';

const log = createScopedLogger({ service: 'attachmentCache' });

const CACHE_DIR_NAME = 'attachment-cache';
const CACHE_EXPIRY_DAYS = 7;
const CACHE_EXPIRY_MS = CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

/** UUID regex for path traversal protection */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cached attachment entry stored on disk */
export interface CachedAttachment {
  id: string;
  payload: AnyAttachmentPayload;
  createdAt: number;
}

/** Result of loading cached attachments */
export interface LoadCacheResult {
  id: string;
  success: boolean;
  payload?: AnyAttachmentPayload;
  error?: string;
}

/**
 * Validate cache ID is a valid UUID (path traversal protection).
 */
const validateCacheId = (id: string): boolean => {
  if (!id || typeof id !== 'string') return false;
  return UUID_REGEX.test(id);
};

/**
 * Get the attachment cache directory path, creating it if needed.
 */
export const getAttachmentCacheDir = (): string => {
  const userDataPath = getDataPath();
  const cacheDir = path.join(userDataPath, CACHE_DIR_NAME);

  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
    log.debug({ cacheDir }, 'Created attachment cache directory');
  }

  return cacheDir;
};

/**
 * Save attachments to cache.
 * Returns array of cache IDs (UUIDs) for each saved attachment.
 */
export const cacheAttachments = async (
  attachments: AnyAttachmentPayload[]
): Promise<string[]> => {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  const cacheDir = getAttachmentCacheDir();
  const cacheIds: string[] = [];

  for (const attachment of attachments) {
    const cacheId = randomUUID();
    const cachePath = path.join(cacheDir, `${cacheId}.json`);

    const cacheEntry: CachedAttachment = {
      id: cacheId,
      payload: attachment,
      createdAt: Date.now(),
    };

    try {
      await fs.writeFile(cachePath, JSON.stringify(cacheEntry), 'utf-8');
      cacheIds.push(cacheId);
      log.debug(
        { cacheId, attachmentName: attachment.name },
        'Cached attachment'
      );
    } catch (error) {
      log.error(
        { error, cacheId, attachmentName: attachment.name },
        'Failed to cache attachment'
      );
    }
  }

  return cacheIds;
};

/**
 * Load cached attachments by their cache IDs.
 * Returns results for each ID with success/failure status.
 */
export const loadCachedAttachments = async (
  cacheIds: string[]
): Promise<LoadCacheResult[]> => {
  if (!cacheIds || cacheIds.length === 0) {
    return [];
  }

  const cacheDir = getAttachmentCacheDir();
  const results: LoadCacheResult[] = [];

  for (const cacheId of cacheIds) {
    if (!validateCacheId(cacheId)) {
      log.warn({ cacheId }, 'Invalid cache ID - possible path traversal attempt');
      results.push({ id: cacheId, success: false, error: 'Invalid cache ID' });
      continue;
    }

    const cachePath = path.join(cacheDir, `${cacheId}.json`);

    try {
      const content = await fs.readFile(cachePath, 'utf-8');
      const cacheEntry: CachedAttachment = JSON.parse(content);

      // Check if expired
      if (Date.now() - cacheEntry.createdAt > CACHE_EXPIRY_MS) {
        log.debug({ cacheId }, 'Cache entry expired');
        await deleteCacheFile(cacheId);
        results.push({ id: cacheId, success: false, error: 'Cache expired' });
        continue;
      }

      results.push({
        id: cacheId,
        success: true,
        payload: cacheEntry.payload,
      });
      log.debug({ cacheId }, 'Loaded cached attachment');
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      log.error({ error, cacheId }, 'Failed to load cached attachment');
      results.push({ id: cacheId, success: false, error: errorMessage });
    }
  }

  return results;
};

/**
 * Delete a single cache file by ID.
 */
export async function deleteCacheFile(cacheId: string): Promise<boolean> {
  if (!validateCacheId(cacheId)) {
    log.warn({ cacheId }, 'Invalid cache ID for deletion');
    return false;
  }

  const cacheDir = getAttachmentCacheDir();
  const cachePath = path.join(cacheDir, `${cacheId}.json`);

  try {
    await fs.unlink(cachePath);
    log.debug({ cacheId }, 'Deleted cache file');
    return true;
  } catch (error) {
    // File might not exist, that's OK
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.error({ error, cacheId }, 'Failed to delete cache file');
    }
    return false;
  }
};

/**
 * Delete multiple cache files by IDs.
 */
export const deleteCacheFiles = async (cacheIds: string[]): Promise<void> => {
  await Promise.all(cacheIds.map((id) => deleteCacheFile(id)));
};

/**
 * Clean up expired cache files.
 * Should be called on app startup.
 */
export const cleanupExpiredCache = async (): Promise<number> => {
  const cacheDir = getAttachmentCacheDir();
  let deletedCount = 0;

  try {
    const files = await fs.readdir(cacheDir);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const filePath = path.join(cacheDir, file);

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const cacheEntry: CachedAttachment = JSON.parse(content);

        if (Date.now() - cacheEntry.createdAt > CACHE_EXPIRY_MS) {
          await fs.unlink(filePath);
          deletedCount++;
          log.debug({ file }, 'Deleted expired cache file');
        }
      } catch {
        // If we can't parse the file, it's corrupted - delete it
        try {
          await fs.unlink(filePath);
          deletedCount++;
          log.debug({ file }, 'Deleted corrupted cache file');
        } catch {
          // Ignore deletion errors
        }
      }
    }

    if (deletedCount > 0) {
      log.info({ deletedCount }, 'Cleaned up expired attachment cache files');
    }
  } catch (error) {
    log.error({ error }, 'Failed to cleanup expired cache');
  }

  return deletedCount;
};
