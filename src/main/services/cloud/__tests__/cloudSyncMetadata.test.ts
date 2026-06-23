import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-sync-meta',
}));

import {
  markCloudSynced,
  isCloudSynced,
  getCloudSyncedAt,
  removeCloudSyncMetadata,
  flushCloudSyncMetadata,
  _resetForTesting,
} from '../cloudSyncMetadata';

const META_PATH = path.join('/tmp/test-cloud-sync-meta', 'sessions', 'cloud-sync-meta.json');

describe('cloudSyncMetadata', () => {
  beforeEach(() => {
    _resetForTesting();
    // Clean up test files
    try { fs.rmSync(path.dirname(META_PATH), { recursive: true, force: true }); } catch { /* ok */ }
  });

  afterEach(() => {
    _resetForTesting();
    try { fs.rmSync(path.dirname(META_PATH), { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('marks a session as cloud-synced', () => {
    markCloudSynced('session-1');
    expect(isCloudSynced('session-1')).toBe(true);
    expect(isCloudSynced('session-2')).toBe(false);
  });

  it('returns undefined for unsynced sessions', () => {
    expect(getCloudSyncedAt('unknown')).toBeUndefined();
  });

  it('removes sync metadata', () => {
    markCloudSynced('session-1');
    expect(isCloudSynced('session-1')).toBe(true);
    removeCloudSyncMetadata('session-1');
    expect(isCloudSynced('session-1')).toBe(false);
  });

  it('remove is idempotent for unknown sessions', () => {
    removeCloudSyncMetadata('nonexistent');
    expect(isCloudSynced('nonexistent')).toBe(false);
  });

  it('persists to disk on flush and reloads', () => {
    markCloudSynced('session-a');
    markCloudSynced('session-b');
    flushCloudSyncMetadata();

    expect(fs.existsSync(META_PATH)).toBe(true);

    const raw = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
    expect(raw['session-a']).toBeTypeOf('number');
    expect(raw['session-b']).toBeTypeOf('number');

    // Reset and reload from disk
    _resetForTesting();
    expect(isCloudSynced('session-a')).toBe(true);
    expect(isCloudSynced('session-b')).toBe(true);
  });

  it('handles missing meta file gracefully', () => {
    // No file exists — should not throw
    expect(isCloudSynced('session-1')).toBe(false);
  });

  it('handles corrupt meta file gracefully', () => {
    fs.mkdirSync(path.dirname(META_PATH), { recursive: true });
    fs.writeFileSync(META_PATH, 'not-json', 'utf8');

    // Should warn and start fresh
    expect(isCloudSynced('session-1')).toBe(false);
    markCloudSynced('session-1');
    expect(isCloudSynced('session-1')).toBe(true);
  });

  it('getCloudSyncedAt returns the timestamp', () => {
    const before = Date.now();
    markCloudSynced('session-1');
    const after = Date.now();

    const ts = getCloudSyncedAt('session-1');
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
