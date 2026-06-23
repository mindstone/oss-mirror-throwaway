// mobile/src/storage/offlineQueueStorage.ts
// Platform-specific QueueStorageAdapter using expo-file-system (new API).
// Persists queue index + payload files to documentDirectory/offline-queue/.

import { Paths, Directory, File as ExpoFile } from 'expo-file-system';
import type { QueueStorageAdapter, QueueItem, QueueSnapshot } from '@rebel/cloud-client';
import { createLogger } from '@rebel/cloud-client';

const log = createLogger('ExpoFileSystemQueueStorage');

const QUEUE_DIR_NAME = 'offline-queue';
const INDEX_FILENAME = 'index.json';
const TMP_INDEX_FILENAME = 'index.json.tmp';
const JSON_PAYLOAD_SUFFIX = '.attachments.json';
const TMP_JSON_PAYLOAD_SUFFIX = '.attachments.json.tmp';
const CURRENT_VERSION = 1;

/**
 * Expo-file-system-backed storage adapter for the offline queue.
 * Uses the new File/Directory API (expo-file-system v19+, SDK 54).
 *
 * Storage layout:
 *   {documentDirectory}/offline-queue/
 *   ├── index.json                        # Queue snapshot (versioned JSON)
 *   ├── index.json.tmp                    # Temp file for atomic writes
 *   ├── {itemId}.{ext}                    # Payload files (e.g., audio)
 *   ├── {itemId}.attachments.json         # JSON payload files (e.g., attachment blobs)
 *   └── ...
 *
 * Atomic index writes: write to index.json.tmp, then rename to index.json
 * to prevent corruption on crash.
 */
export class ExpoFileSystemQueueStorage implements QueueStorageAdapter {
  private readonly queueDir: Directory;
  private dirEnsured = false;

  constructor() {
    this.queueDir = new Directory(Paths.document, QUEUE_DIR_NAME);
  }

  private ensureDir(): void {
    if (this.dirEnsured) return;
    try {
      if (!this.queueDir.exists) {
        this.queueDir.create({ intermediates: true, idempotent: true });
      }
      this.dirEnsured = true;
    } catch (err) {
      log.error('Failed to create queue directory', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Persist the full queue index atomically.
   * Writes to index.json.tmp then renames to index.json (crash-safe).
   *
   * IMPORTANT: File instances are created fresh each call because
   * expo-file-system's rename() mutates the object's URI (both iOS and
   * Android native layers update the internal path after rename).
   * Reusing constructor-level instances would cause the second call to
   * operate on the wrong file path.
   */
  async saveSnapshot(items: QueueItem[]): Promise<void> {
    this.ensureDir();

    const snapshot: QueueSnapshot = {
      version: CURRENT_VERSION,
      items,
    };
    const json = JSON.stringify(snapshot);

    // Fresh File references — rename() mutates the object's URI.
    const tmpFile = new ExpoFile(this.queueDir, TMP_INDEX_FILENAME);
    const indexFile = new ExpoFile(this.queueDir, INDEX_FILENAME);

    // Write to tmp file
    if (tmpFile.exists) tmpFile.delete();
    tmpFile.create();
    tmpFile.write(json);

    // Best-effort atomic rename: tmp → final.
    // Delete the existing index first, then rename the tmp file.
    // Using rename() instead of move() — rename operates within the same
    // directory and avoids the native "destination doesn't exist" error
    // that move(File) can throw when the target was just deleted.
    // Note: on Android <26, rename() falls back to copy+delete, so this
    // is not truly atomic on older devices. loadSnapshot() recovery
    // handles the crash-between-delete-and-rename window.
    if (indexFile.exists) indexFile.delete();
    tmpFile.rename(INDEX_FILENAME);
  }

  /**
   * Load all queue items from persisted index.
   * Returns empty array if index doesn't exist or is corrupt.
   */
  async loadSnapshot(depth = 0): Promise<QueueItem[]> {
    try {
      // Fresh File references — rename() mutates the object's URI.
      const indexFile = new ExpoFile(this.queueDir, INDEX_FILENAME);
      const tmpFile = new ExpoFile(this.queueDir, TMP_INDEX_FILENAME);

      if (!indexFile.exists) {
        if (!tmpFile.exists) return [];

        if (depth > 0) {
          log.warn('Queue index recovery exceeded max depth, returning empty snapshot');
          return [];
        }

        log.warn('Primary queue index missing, recovering from temp index');
        tmpFile.rename(INDEX_FILENAME);
        return this.loadSnapshot(depth + 1);
      }

      const json = await indexFile.text();
      const snapshot = JSON.parse(json) as QueueSnapshot;

      if (!snapshot || snapshot.version !== CURRENT_VERSION) {
        log.warn('Unsupported index version, treating as empty', {
          version: (snapshot as unknown as Record<string, unknown>)?.version,
        });
        return [];
      }

      return snapshot.items ?? [];
    } catch (err) {
      log.error('Failed to load queue index', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Copy a file from sourceUri (e.g., expo-audio temp path) to queue storage.
   * Returns the persisted file URI.
   */
  async savePayloadFromUri(id: string, sourceUri: string, ext: string): Promise<string> {
    this.ensureDir();

    const destFile = new ExpoFile(this.queueDir, `${id}.${ext}`);
    const srcFile = new ExpoFile(sourceUri);
    srcFile.copy(destFile);

    log.debug('Payload saved', { id, ext });
    return destFile.uri;
  }

  /**
   * Get the persisted file URI for a queue item's payload.
   * Returns null if the file doesn't exist.
   */
  async getPayloadUri(id: string): Promise<string | null> {
    const match = this.findPayloadFilename(id);
    if (!match) return null;
    return new ExpoFile(this.queueDir, match).uri;
  }

  /**
   * Delete a queue item's payload file(s) — both media payload and JSON payload.
   * No-op if the files don't exist (idempotent).
   */
  async deletePayload(id: string): Promise<void> {
    try {
      // Delete media payload (e.g., {id}.m4a)
      const filename = this.findPayloadFilename(id);
      if (filename) {
        const file = new ExpoFile(this.queueDir, filename);
        if (file.exists) {
          file.delete();
          log.debug('Payload deleted', { id });
        }
      }

      // Also delete JSON payload if it exists
      await this.deleteJsonPayload(id);
    } catch (err) {
      log.warn('Failed to delete payload', {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * List all payload IDs in storage (for orphan recovery).
   * Returns the deduplicated set of IDs from both media payloads and JSON payloads.
   */
  async listPayloadIds(): Promise<string[]> {
    try {
      const filenames = this.listAllPayloadFilenames();
      const ids = new Set<string>();
      for (const f of filenames) {
        // Extract ID: strip .attachments.json suffix first, then fall back to last-dot split
        if (f.endsWith(JSON_PAYLOAD_SUFFIX)) {
          ids.add(f.slice(0, -JSON_PAYLOAD_SUFFIX.length));
        } else {
          const dotIndex = f.lastIndexOf('.');
          ids.add(dotIndex > 0 ? f.slice(0, dotIndex) : f);
        }
      }
      return Array.from(ids);
    } catch (err) {
      log.warn('Failed to list payload IDs', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Persist arbitrary JSON payload for a queue item (e.g., attachment blob).
   * Uses atomic tmp+rename pattern matching saveSnapshot.
   */
  async saveJsonPayload(id: string, payload: unknown): Promise<void> {
    this.ensureDir();

    const json = JSON.stringify(payload);
    const tmpFile = new ExpoFile(this.queueDir, `${id}${TMP_JSON_PAYLOAD_SUFFIX}`);
    const destFile = new ExpoFile(this.queueDir, `${id}${JSON_PAYLOAD_SUFFIX}`);

    // Atomic write: tmp → rename
    if (tmpFile.exists) tmpFile.delete();
    tmpFile.create();
    tmpFile.write(json);

    if (destFile.exists) destFile.delete();
    tmpFile.rename(`${id}${JSON_PAYLOAD_SUFFIX}`);

    log.debug('JSON payload saved', { id });
  }

  /**
   * Load previously-saved JSON payload. Returns null if not found or corrupt.
   * If the primary file is missing but a .tmp file exists (crash between
   * write and rename), recovers from the tmp file — mirrors loadSnapshot pattern.
   */
  async loadJsonPayload<T = unknown>(id: string, depth = 0): Promise<T | null> {
    try {
      const primaryFile = new ExpoFile(this.queueDir, `${id}${JSON_PAYLOAD_SUFFIX}`);
      const tmpFile = new ExpoFile(this.queueDir, `${id}${TMP_JSON_PAYLOAD_SUFFIX}`);

      if (!primaryFile.exists) {
        if (!tmpFile.exists) return null;
        if (depth > 0) {
          log.warn('JSON payload recovery exceeded max depth', { id });
          return null;
        }
        log.warn('Primary JSON payload missing, recovering from temp', { id });
        tmpFile.rename(`${id}${JSON_PAYLOAD_SUFFIX}`);
        return this.loadJsonPayload<T>(id, depth + 1);
      }

      const json = await primaryFile.text();
      return JSON.parse(json) as T;
    } catch (err) {
      log.warn('Failed to load JSON payload', { id, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /**
   * Delete JSON payload file. No-op if not found.
   */
  async deleteJsonPayload(id: string): Promise<void> {
    try {
      const file = new ExpoFile(this.queueDir, `${id}${JSON_PAYLOAD_SUFFIX}`);
      if (file.exists) {
        file.delete();
        log.debug('JSON payload deleted', { id });
      }
      // Also clean up any orphaned tmp file
      const tmpFile = new ExpoFile(this.queueDir, `${id}${TMP_JSON_PAYLOAD_SUFFIX}`);
      if (tmpFile.exists) {
        tmpFile.delete();
      }
    } catch (err) {
      log.warn('Failed to delete JSON payload', {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Find the media payload filename for a given ID (excludes JSON payloads). */
  private findPayloadFilename(id: string): string | undefined {
    const filenames = this.listAllPayloadFilenames();
    return filenames.find(
      (filename) => filename.startsWith(`${id}.`) && !filename.endsWith(JSON_PAYLOAD_SUFFIX),
    );
  }

  /** List all payload filenames (media + JSON), excluding index files. */
  private listAllPayloadFilenames(): string[] {
    try {
      if (!this.queueDir.exists) return [];
      const entries = this.queueDir.list();
      return entries
        .filter((entry): entry is ExpoFile => entry instanceof ExpoFile)
        .map((file) => file.name)
        .filter(
          (name) =>
            !name.startsWith(INDEX_FILENAME) &&
            !name.endsWith(TMP_JSON_PAYLOAD_SUFFIX),
        );
    } catch {
      return [];
    }
  }
}
