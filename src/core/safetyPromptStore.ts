/**
 * Safety Prompt Store
 *
 * Persists the user's Safety Prompt (principles document), version history,
 * and migration state. Uses the core StoreFactory for platform-agnostic
 * persistence (Electron: electron-store, Cloud: JSON file).
 */

import { createScopedLogger } from '@core/logger';
import type { KeyValueStore } from '@core/store';
import { safeCreateStore } from '@core/utils/loadStoreSafely';
import type {
  SafetyPromptHistoryEntry,
  SafetyPromptStoreSchema,
  SafetyPromptUpdater,
} from './safetyPromptTypes';
import { addVersionChangeEntry } from './safetyActivityLogStore';
import type { VersionChangeEntry } from './safetyActivityLogTypes';
import { SAFETY_PROMPT_MAX_HISTORY } from './safetyPromptTypes';

// Re-export from @shared so existing @core consumers don't break
export { DEFAULT_SAFETY_PROMPT } from '@shared/safetyPromptDefaults';
import { DEFAULT_SAFETY_PROMPT } from '@shared/safetyPromptDefaults';

const log = createScopedLogger({ service: 'safetyPromptStore' });

export const SAFETY_PROMPT_STORE_VERSION = 1;

const createDefaultState = (): SafetyPromptStoreSchema => ({
  safetyPrompt: DEFAULT_SAFETY_PROMPT,
  version: 0,
  lastUpdatedAt: 0,
  lastUpdatedBy: 'system',
  migrationComplete: false,
  history: [],
});

export interface SafetyPromptWithMeta {
  prompt: string;
  version: number;
  lastUpdatedAt: number;
  lastUpdatedBy: SafetyPromptUpdater;
  history: SafetyPromptHistoryEntry[];
  migrationComplete: boolean;
}

let _store: KeyValueStore<SafetyPromptStoreSchema> | null = null;

/**
 * Read-only latch for the safety prompt store. This is REAL user-controlled
 * safety policy + version history — NOT a rebuildable cache. If the backing
 * `safety-prompt.json` is present-but-unreadable (corrupt JSON / schema /
 * decrypt / transient IO), `safeCreateStore` preserves+backs up the raw file and
 * hands back an ephemeral read-only store with `loadFailed: true`. We latch
 * read-only so writers (`updateSafetyPrompt`, `revertToVersion`,
 * `setMigrationComplete`, `resetToDefaults`) refuse to persist — otherwise the
 * first write (especially `resetToDefaults`) would clobber the user's real
 * policy/history with defaults. Read-only-until-restart by design.
 */
let _safetyPromptReadOnlyMode = false;

function getStore(): KeyValueStore<SafetyPromptStoreSchema> {
  if (!_store) {
    // Guard CONSTRUCTION: conf throws at construct time when the backing file is
    // corrupt. `safeCreateStore` preserves+backs up the raw file, latches an
    // ephemeral read-only store, and never crashes init.
    const created = safeCreateStore<SafetyPromptStoreSchema>(
      { name: 'safety-prompt', defaults: createDefaultState() },
      createDefaultState(),
    );
    _store = created.store;
    if (created.loadFailed) {
      _safetyPromptReadOnlyMode = true;
    }
  }
  return _store;
}

/**
 * Read-only check that GUARANTEES construction (and thus the latch) ran first.
 * `_safetyPromptReadOnlyMode` defaults to `false` and is only set during the
 * one-time `getStore()` construction; a writer checking the bare flag as a
 * first touch would see a stale `false` and bypass the guard. Calling
 * `getStore()` here forces construction before we read the flag, making every
 * write guard first-touch-safe by construction.
 */
function isSafetyPromptReadOnly(): boolean {
  getStore();
  return _safetyPromptReadOnlyMode;
}

export function getSafetyPrompt(): string {
  try {
    return getStore().get('safetyPrompt', DEFAULT_SAFETY_PROMPT);
  } catch (error) {
    log.error({ err: error }, 'Failed to read safety prompt');
    return DEFAULT_SAFETY_PROMPT;
  }
}

export function getSafetyPromptVersion(): number {
  try {
    return getStore().get('version', 0);
  } catch (error) {
    log.error({ err: error }, 'Failed to read safety prompt version');
    return 0;
  }
}

export function getHistory(): SafetyPromptHistoryEntry[] {
  try {
    return getStore().get('history', []);
  } catch (error) {
    log.error({ err: error }, 'Failed to read safety prompt history');
    return [];
  }
}

export function getSafetyPromptWithMeta(): SafetyPromptWithMeta {
  try {
    const store = getStore();
    return {
      prompt: store.get('safetyPrompt', DEFAULT_SAFETY_PROMPT),
      version: store.get('version', 0),
      lastUpdatedAt: store.get('lastUpdatedAt', 0),
      lastUpdatedBy: store.get('lastUpdatedBy', 'system'),
      history: store.get('history', []),
      migrationComplete: store.get('migrationComplete', false),
    };
  } catch (error) {
    log.error({ err: error }, 'Failed to read safety prompt metadata');
    const defaults = createDefaultState();
    return {
      prompt: defaults.safetyPrompt,
      version: defaults.version,
      lastUpdatedAt: defaults.lastUpdatedAt,
      lastUpdatedBy: defaults.lastUpdatedBy,
      history: defaults.history,
      migrationComplete: defaults.migrationComplete,
    };
  }
}

export function updateSafetyPrompt(
  prompt: string,
  updatedBy: SafetyPromptUpdater,
  source?: VersionChangeEntry['source'],
): void {
  if (isSafetyPromptReadOnly()) {
    log.warn('Skipping safety prompt update - store is in read-only mode (load failure); on-disk policy/history preserved');
    return;
  }
  try {
    const store = getStore();
    const currentPrompt = store.get('safetyPrompt', DEFAULT_SAFETY_PROMPT);
    const currentVersion = store.get('version', 0);
    const currentLastUpdatedAt = store.get('lastUpdatedAt', 0);
    const currentLastUpdatedBy = store.get('lastUpdatedBy', 'system');
    const currentHistory = store.get('history', []);

    const previousEntry: SafetyPromptHistoryEntry = {
      prompt: currentPrompt,
      version: currentVersion,
      updatedAt: currentLastUpdatedAt,
      updatedBy: currentLastUpdatedBy,
    };

    const nextHistory = [...currentHistory, previousEntry].slice(-SAFETY_PROMPT_MAX_HISTORY);
    const now = Date.now();

    store.set({
      safetyPrompt: prompt,
      version: currentVersion + 1,
      lastUpdatedAt: now,
      lastUpdatedBy: updatedBy,
      history: nextHistory,
    });

    if (source) {
      addVersionChangeEntry(currentVersion, currentVersion + 1, source);
    }

    log.info(
      { version: currentVersion + 1, updatedBy, source, historyLength: nextHistory.length },
      'Updated safety prompt'
    );
  } catch (error) {
    log.error({ err: error }, 'Failed to update safety prompt');
  }
}

export function revertToVersion(targetVersion: number): boolean {
  if (isSafetyPromptReadOnly()) {
    log.warn({ targetVersion }, 'Skipping safety prompt revert - store is in read-only mode (load failure); on-disk policy/history preserved');
    return false;
  }
  try {
    const store = getStore();
    const currentVersion = store.get('version', 0);

    if (targetVersion === currentVersion) {
      return true;
    }

    const history = store.get('history', []);
    const target = history.find((entry) => entry.version === targetVersion);

    if (!target) {
      return false;
    }

    const previousEntry: SafetyPromptHistoryEntry = {
      prompt: store.get('safetyPrompt', DEFAULT_SAFETY_PROMPT),
      version: currentVersion,
      updatedAt: store.get('lastUpdatedAt', 0),
      updatedBy: store.get('lastUpdatedBy', 'system'),
    };

    const nextVersion = currentVersion + 1;
    const nextHistory = [...history, previousEntry].slice(-SAFETY_PROMPT_MAX_HISTORY);

    store.set({
      safetyPrompt: target.prompt,
      version: nextVersion,
      lastUpdatedAt: Date.now(),
      lastUpdatedBy: 'user',
      history: nextHistory,
    });

    log.info(
      { targetVersion, nextVersion, historyLength: nextHistory.length },
      'Reverted safety prompt to previous version'
    );
    return true;
  } catch (error) {
    log.error({ err: error, targetVersion }, 'Failed to revert safety prompt version');
    return false;
  }
}

export function isMigrationComplete(): boolean {
  try {
    return getStore().get('migrationComplete', false);
  } catch (error) {
    log.error({ err: error }, 'Failed to read migrationComplete flag');
    return false;
  }
}

export function setMigrationComplete(complete: boolean): void {
  if (isSafetyPromptReadOnly()) {
    log.warn({ complete }, 'Skipping safety prompt migrationComplete update - store is in read-only mode (load failure); on-disk policy/history preserved');
    return;
  }
  try {
    getStore().set('migrationComplete', complete);
    log.info({ complete }, 'Updated migrationComplete flag for safety prompt store');
  } catch (error) {
    log.error({ err: error, complete }, 'Failed to update migrationComplete flag');
  }
}

export function resetToDefaults(): void {
  if (isSafetyPromptReadOnly()) {
    // CRITICAL: without this guard, an explicit reset over a present-but-
    // unreadable file would overwrite the user's real safety policy/history
    // with defaults — the F1 wipe class. The real file stays preserved on disk.
    log.warn('Skipping safety prompt reset-to-defaults - store is in read-only mode (load failure); on-disk policy/history preserved');
    return;
  }
  try {
    getStore().store = createDefaultState();
    log.info('Reset safety prompt store to defaults');
  } catch (error) {
    log.error({ err: error }, 'Failed to reset safety prompt store to defaults');
  }
}

export function resetStoreForTesting(): void {
  _store = null;
  _safetyPromptReadOnlyMode = false;
}
