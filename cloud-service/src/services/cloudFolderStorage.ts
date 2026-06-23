/**
 * Cloud-side storage for the conversation-folders document.
 *
 * Carrier for `PUT`/`GET /api/sessions/folders` (Carrier Option A — see
 * docs/plans/260611_fix-cloud-migration-folders/PLAN.md). The whole
 * `FolderStoreData` document (folder defs + membership + version) is persisted
 * as a single atomic JSON file under the cloud data root, mirroring how the
 * sessions route stores asset/content sidecars (`getDataPath()/sessions/...`).
 *
 * An in-memory cache is primed on save so a GET-after-PUT in the same process
 * reflects the stored doc immediately (Stage 1 handoff F4), independent of disk
 * read latency. Cloud-service is per-user-per-instance, so no per-user scoping
 * is needed (one document per instance).
 */

import { writeFile } from 'atomically';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { getDataPath } from '@core/utils/dataPaths';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import {
  EMPTY_FOLDER_STORE_DATA,
  parseFolderStoreData,
  type FolderStoreData,
} from '@shared/ipc/schemas/folders';

const SESSIONS_DIR = 'sessions';
const FOLDERS_FILENAME = 'folders.json';

let cache: FolderStoreData | null = null;

function foldersFilePath(): string {
  return path.join(getDataPath(), SESSIONS_DIR, FOLDERS_FILENAME);
}

/**
 * Read the stored folders document. Returns the in-memory cache when primed,
 * else reads + parses disk. On any miss (no file / malformed / bad version)
 * returns the empty default document — a fresh instance simply has no folders.
 */
export async function readCloudFolders(): Promise<FolderStoreData> {
  if (cache) return cache;
  try {
    const raw = await fsp.readFile(foldersFilePath(), 'utf8');
    const parsed = parseFolderStoreData(JSON.parse(raw));
    cache = parsed ?? { ...EMPTY_FOLDER_STORE_DATA };
    return cache;
  } catch (err) {
    // No file yet / unreadable / malformed JSON ⇒ a fresh instance simply has
    // no folders. Returning the empty default is intentional and non-fatal.
    ignoreBestEffortCleanup(err, {
      operation: 'read_cloud_folders',
      reason: 'missing/corrupt folders.json ⇒ empty default document',
    });
    return { ...EMPTY_FOLDER_STORE_DATA };
  }
}

/**
 * Persist the folders document atomically and prime the cache so a subsequent
 * GET in the same process returns it without a disk round-trip.
 */
export async function writeCloudFolders(data: FolderStoreData): Promise<void> {
  cache = data;
  const filePath = foldersFilePath();
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data), 'utf8');
}

/** Test-only: drop the in-memory cache + any persisted file between cases. */
export async function _resetCloudFoldersCacheForTests(): Promise<void> {
  cache = null;
  await fsp.rm(foldersFilePath(), { force: true }).catch((err) => {
    ignoreBestEffortCleanup(err, {
      operation: 'reset_cloud_folders_cache_for_tests',
      reason: 'best-effort test cleanup — absent file is fine',
    });
  });
}
