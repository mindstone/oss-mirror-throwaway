/**
 * Persistent cache of Google Drive revision content hashes.
 *
 * Google Drive revisions are immutable: a given (`file_id`,
 * `revision_id`) pair always refers to the same bytes. Once we have
 * downloaded and hashed a revision's content, we never need to
 * download it again for dedup purposes — the cache survives app
 * restarts so the first-open cost is paid at most once per revision
 * ever seen on this device.
 *
 * Used by `driveSkillHistoryService` to collapse no-op revisions
 * (adjacent revisions with identical content) before presenting the
 * version history UI. See
 * `docs-private/investigations/260421_drive_file_id_resolution_lessons.md`
 * for the full rationale.
 *
 * Scope intentionally narrow: stores only the content hash + a
 * timestamp, not the body. Body cache (if ever needed for instant
 * preview) lives in-memory per session.
 */
import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';

// Per-file: revisionId → { contentHash, cachedAt }
export type FileRevisionHashes = Record<string, { hash: string; cachedAt: number }>;

type RevisionHashStoreState = {
  // fileId → { revisionId → { hash, cachedAt } }
  byFileId: Record<string, FileRevisionHashes>;
};

const createDefaultState = (): RevisionHashStoreState => ({
  byFileId: {},
});

let _store: KeyValueStore<RevisionHashStoreState> | null = null;

function getStore(): KeyValueStore<RevisionHashStoreState> {
  if (!_store) {
    _store = createStore<RevisionHashStoreState>({
      name: 'drive-revision-hashes',
      defaults: createDefaultState(),
    });
  }
  return _store;
}

export function getCachedRevisionHashes(fileId: string): FileRevisionHashes {
  const all = getStore().get('byFileId', {});
  return all[fileId] ?? {};
}

export function setCachedRevisionHashes(
  fileId: string,
  updates: FileRevisionHashes,
): void {
  const store = getStore();
  const all = store.get('byFileId', {});
  const existing = all[fileId] ?? {};
  const merged: FileRevisionHashes = { ...existing, ...updates };
  store.set('byFileId', { ...all, [fileId]: merged });
}

/**
 * Prune cached hashes for a file to keep the cache bounded. Drops
 * entries older than `maxEntries` by `cachedAt`. No-op if the file
 * has fewer entries than the cap.
 */
export function pruneCachedRevisionHashes(fileId: string, maxEntries = 500): void {
  const store = getStore();
  const all = store.get('byFileId', {});
  const existing = all[fileId];
  if (!existing) return;

  const entries = Object.entries(existing);
  if (entries.length <= maxEntries) return;

  entries.sort((a, b) => b[1].cachedAt - a[1].cachedAt);
  const retained = Object.fromEntries(entries.slice(0, maxEntries));
  store.set('byFileId', { ...all, [fileId]: retained });
}
