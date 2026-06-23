/**
 * FolderStore — persistence layer for conversation folders.
 *
 * Stores folder definitions and session→folder membership in `folders.json`
 * inside the `userData/sessions/` directory. This is a standalone file that
 * does NOT touch AgentSession or the session index.
 *
 * Follows the same file I/O patterns as IncrementalSessionStore:
 * - Atomic writes via `atomically`
 * - In-memory cache
 * - Zod validation on load
 * - Graceful degradation on corruption (empty defaults)
 *
 * @see docs/plans/260408_sidebar_conversation_folders.md
 */

import { writeFile, writeFileSync } from 'atomically';
import * as fs from 'fs';
import * as path from 'path';
import { createScopedLogger } from '@core/logger';
import { getDataPath } from '../utils/dataPaths';
import { FolderStoreDataSchema, type FolderStoreData } from '@shared/ipc/schemas/folders';
import { classifyLoadFailure } from '@core/utils/loadStoreSafely';

const log = createScopedLogger({ service: 'folderStore' });

const SESSIONS_DIR = 'sessions';
const FOLDERS_FILENAME = 'folders.json';

const EMPTY_STORE_DATA: FolderStoreData = {
  version: 1,
  folders: [],
  membership: {},
};

export class FolderStore {
  private readonly filePath: string;
  private cache: FolderStoreData | null = null;
  // Load-failure read-only latch. Set when a load fails on EXISTING data
  // (unparseable JSON, schema-invalid, or unreadable file). Blocks ALL writes so
  // a single malformed membership entry / schema drift can NEVER wipe folders.
  private readOnlyMode = false;

  constructor() {
    const userDataPath = getDataPath();
    this.filePath = path.join(userDataPath, SESSIONS_DIR, FOLDERS_FILENAME);
  }

  /** Whether the store is load-failed read-only (writes blocked, data preserved). */
  isReadOnly(): boolean {
    // Force a load so a first-touch writer sees an authoritative flag.
    this.load();
    return this.readOnlyMode;
  }

  /**
   * Load folder state from disk. Returns cached data if available.
   *
   * Invariant: a load failure on EXISTING data must NEVER overwrite it with
   * defaults. We distinguish a truly-absent file (ENOENT → legitimate fresh
   * init, persist defaults) from an existing-but-unreadable/invalid file
   * (preserve the raw bytes, back them up, latch read-only, serve ephemeral
   * in-memory defaults). Previously a JSON-parse error OR a Zod schema failure
   * reset folders to empty AND `writeSync`-persisted that wipe — the exact
   * "folders look empty" data-loss class this guard exists to prevent.
   */
  load(): FolderStoreData {
    if (this.cache) return this.cache;

    if (!fs.existsSync(this.filePath)) {
      log.info('No folders.json found, initializing with empty defaults');
      this.cache = { ...EMPTY_STORE_DATA };
      this.writeSync(this.cache);
      return this.cache;
    }

    let parsed: unknown;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      parsed = JSON.parse(raw);
    } catch (err) {
      // Unreadable file or unparseable JSON on an EXISTING file. Preserve it,
      // back up the raw bytes, latch read-only, serve ephemeral defaults.
      this.enterLoadFailedReadOnly(err);
      this.cache = { ...EMPTY_STORE_DATA };
      return this.cache;
    }

    const result = FolderStoreDataSchema.safeParse(parsed);
    if (!result.success) {
      // Parsed fine but schema-invalid (e.g. one malformed membership entry /
      // schema drift). The file EXISTS and may hold real data — do NOT reset or
      // persist. Preserve + back up + read-only.
      this.enterLoadFailedReadOnly(
        new Error(`folders.json failed schema validation: ${result.error.issues.length} issue(s)`),
      );
      this.cache = { ...EMPTY_STORE_DATA };
      return this.cache;
    }

    this.readOnlyMode = false;
    this.cache = result.data;
    log.info({ folderCount: result.data.folders.length, membershipCount: Object.keys(result.data.membership).length }, 'Loaded folder state');
    return this.cache;
  }

  /**
   * Enter the load-failed read-only state: classify (here the file is known to
   * exist), back up the raw bytes, and report. Observable, never throws.
   */
  private enterLoadFailedReadOnly(error: unknown): void {
    this.readOnlyMode = true;
    const classified = classifyLoadFailure('folders', this.filePath, error);
    // `absent` is unreachable here (we already confirmed existsSync), but if the
    // file vanished between checks treat it as fresh and clear the latch.
    if (classified.outcome === 'absent') {
      this.readOnlyMode = false;
    }
  }

  /**
   * Save folder state to disk asynchronously (atomic write).
   */
  async save(data: FolderStoreData): Promise<void> {
    if (this.isReadOnly()) {
      log.warn('Skipping folder save - operating in read-only mode (load failed on existing data)');
      return;
    }
    this.cache = data;
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
    const json = JSON.stringify(data);
    await writeFile(this.filePath, json, 'utf8');
  }

  /**
   * Save folder state to disk synchronously.
   * Used for quit-flush (before-quit handler) where async won't complete.
   */
  saveSync(data: FolderStoreData): void {
    if (this.isReadOnly()) {
      log.warn('Skipping folder saveSync - operating in read-only mode (load failed on existing data)');
      return;
    }
    this.cache = data;
    this.writeSync(data);
  }

  private writeSync(data: FolderStoreData): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const json = JSON.stringify(data);
    writeFileSync(this.filePath, json, 'utf8');
  }
}

// Singleton
let folderStoreInstance: FolderStore | null = null;

export function getFolderStore(): FolderStore {
  if (!folderStoreInstance) {
    folderStoreInstance = new FolderStore();
  }
  return folderStoreInstance;
}
