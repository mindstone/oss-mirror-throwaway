import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

let tempDir: string;

// Mock dataPaths to use temp directory
vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: () => tempDir,
}));

// Mock storeFactory for legacy migration tests
let legacyStoreData: Record<string, unknown> = {};
vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn((options: { name: string; defaults?: Record<string, unknown> }) => {
    if (options.name === 'plugin-storage') {
      if (Object.keys(legacyStoreData).length === 0) {
        legacyStoreData = { ...(options.defaults ?? {}) };
      }
      return {
        get: (key: string) => legacyStoreData[key],
        set: (keyOrObject: string | Record<string, unknown>, value?: unknown) => {
          if (typeof keyOrObject === 'string') {
            legacyStoreData[keyOrObject] = value;
          } else {
            Object.assign(legacyStoreData, keyOrObject);
          }
        },
        has: (key: string) => key in legacyStoreData,
        delete: (key: string) => { delete legacyStoreData[key]; },
        clear: () => { legacyStoreData = {}; },
        get store() { return legacyStoreData; },
        path: '/mock/plugin-storage.json',
      };
    }
    throw new Error(`Unexpected store: ${options.name}`);
  }),
}));

import { PluginDataFileBackend } from '../pluginDataFileBackend';

// ── Helpers ──────────────────────────────────────────────────────────────

async function readDataFile(pluginId: string): Promise<Record<string, unknown>> {
  const filePath = path.join(tempDir, 'plugin-data', pluginId, 'data.json');
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

async function writeDataFile(pluginId: string, data: Record<string, unknown>): Promise<void> {
  const dir = path.join(tempDir, 'plugin-data', pluginId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'data.json'), JSON.stringify(data), 'utf-8');
}

async function dataFileExists(pluginId: string): Promise<boolean> {
  try {
    await fs.access(path.join(tempDir, 'plugin-data', pluginId, 'data.json'));
    return true;
  } catch {
    return false;
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('PluginDataFileBackend', () => {
  let backend: PluginDataFileBackend;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-plugindata-'));
    legacyStoreData = {};
    backend = new PluginDataFileBackend();
  });

  afterEach(async () => {
    backend._resetForTests();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  // ── CRUD operations ──────────────────────────────────────────────────

  describe('CRUD operations', () => {
    it('returns undefined for a key that does not exist', async () => {
      const value = await backend.get('plugin-a', 'nonexistent');
      expect(value).toBeUndefined();
    });

    it('set and get round-trip', async () => {
      const result = await backend.set('plugin-a', 'greeting', 'hello');
      expect(result).toEqual({ ok: true });

      const value = await backend.get('plugin-a', 'greeting');
      expect(value).toBe('hello');
    });

    it('stores complex objects', async () => {
      const data = { items: [1, 2, 3], nested: { flag: true } };
      await backend.set('plugin-a', 'config', data);

      const value = await backend.get('plugin-a', 'config');
      expect(value).toEqual(data);
    });

    it('overwrites existing key', async () => {
      await backend.set('plugin-a', 'count', 1);
      await backend.set('plugin-a', 'count', 42);

      const value = await backend.get('plugin-a', 'count');
      expect(value).toBe(42);
    });

    it('delete removes a key', async () => {
      await backend.set('plugin-a', 'key1', 'val1');
      await backend.set('plugin-a', 'key2', 'val2');
      await backend.delete('plugin-a', 'key1');

      expect(await backend.get('plugin-a', 'key1')).toBeUndefined();
      expect(await backend.get('plugin-a', 'key2')).toBe('val2');
    });

    it('delete on nonexistent key does not throw', async () => {
      await expect(backend.delete('plugin-a', 'nope')).resolves.toBeUndefined();
    });

    it('clear removes all data for a plugin', async () => {
      await backend.set('plugin-a', 'key1', 'val1');
      await backend.set('plugin-a', 'key2', 'val2');
      await backend._waitForPendingFlushes();

      await backend.clear('plugin-a');

      expect(await backend.get('plugin-a', 'key1')).toBeUndefined();
      expect(await backend.get('plugin-a', 'key2')).toBeUndefined();
      expect(await dataFileExists('plugin-a')).toBe(false);
    });

    it('clear on nonexistent plugin does not throw', async () => {
      await expect(backend.clear('no-such-plugin')).resolves.toBeUndefined();
    });
  });

  // ── Plugin isolation ──────────────────────────────────────────────────

  describe('plugin isolation', () => {
    it('data for plugin A is isolated from plugin B', async () => {
      await backend.set('plugin-a', 'secret', 'a-value');
      await backend.set('plugin-b', 'secret', 'b-value');

      expect(await backend.get('plugin-a', 'secret')).toBe('a-value');
      expect(await backend.get('plugin-b', 'secret')).toBe('b-value');
    });

    it('clearing plugin A does not affect plugin B', async () => {
      await backend.set('plugin-a', 'key', 'a-val');
      await backend.set('plugin-b', 'key', 'b-val');
      await backend._waitForPendingFlushes();

      await backend.clear('plugin-a');

      expect(await backend.get('plugin-a', 'key')).toBeUndefined();
      expect(await backend.get('plugin-b', 'key')).toBe('b-val');
    });
  });

  // ── Disk persistence ──────────────────────────────────────────────────

  describe('disk persistence', () => {
    it('flushes data to disk after debounce', async () => {
      await backend.set('plugin-a', 'color', 'blue');
      await backend._waitForPendingFlushes();

      const onDisk = await readDataFile('plugin-a');
      expect(onDisk.color).toBe('blue');
    });

    it('data.json is valid JSON after flush', async () => {
      await backend.set('plugin-a', 'items', [1, 2, 3]);
      await backend._waitForPendingFlushes();

      const filePath = path.join(tempDir, 'plugin-data', 'plugin-a', 'data.json');
      const raw = await fs.readFile(filePath, 'utf-8');
      expect(() => JSON.parse(raw)).not.toThrow();
    });

    it('coalesces multiple writes into a single flush', async () => {
      await backend.set('plugin-a', 'a', 1);
      await backend.set('plugin-a', 'b', 2);
      await backend.set('plugin-a', 'c', 3);
      await backend._waitForPendingFlushes();

      const onDisk = await readDataFile('plugin-a');
      expect(onDisk).toEqual({ a: 1, b: 2, c: 3 });
    });
  });

  // ── Cache behavior ────────────────────────────────────────────────────

  describe('cache behavior', () => {
    it('reads from cache without disk I/O on subsequent gets', async () => {
      await backend.set('plugin-a', 'cached', 'yes');

      // Modify on-disk data behind the backend's back
      await backend._waitForPendingFlushes();
      await writeDataFile('plugin-a', { cached: 'modified-on-disk' });

      // Should still return cached value
      const value = await backend.get('plugin-a', 'cached');
      expect(value).toBe('yes');
    });

    it('loads from disk on first access (cold cache)', async () => {
      // Pre-populate data on disk
      await writeDataFile('plugin-a', { preexisting: 'data' });

      const value = await backend.get('plugin-a', 'preexisting');
      expect(value).toBe('data');
    });
  });

  // ── getUsageBytes ─────────────────────────────────────────────────────

  describe('getUsageBytes', () => {
    it('returns correct byte count for plugin data', async () => {
      await backend.set('plugin-a', 'name', 'hello');

      const bytes = await backend.getUsageBytes('plugin-a');
      const expected = new TextEncoder().encode(JSON.stringify({ name: 'hello' })).byteLength;
      expect(bytes).toBe(expected);
    });

    it('returns 2 bytes for empty plugin (empty JSON object)', async () => {
      const bytes = await backend.getUsageBytes('empty-plugin');
      // JSON.stringify({}) = '{}' = 2 bytes
      expect(bytes).toBe(2);
    });
  });

  // ── exportAll ─────────────────────────────────────────────────────────

  describe('exportAll', () => {
    it('returns all keys for a plugin', async () => {
      await backend.set('plugin-a', 'key1', 'val1');
      await backend.set('plugin-a', 'key2', 42);

      const all = await backend.exportAll('plugin-a');
      expect(all).toEqual({ key1: 'val1', key2: 42 });
    });

    it('returns empty object for unknown plugin', async () => {
      const all = await backend.exportAll('unknown');
      expect(all).toEqual({});
    });

    it('returns a copy (not the internal cache reference)', async () => {
      await backend.set('plugin-a', 'key', 'val');

      const exported = await backend.exportAll('plugin-a');
      exported.key = 'mutated';

      // Internal cache should be unaffected
      const value = await backend.get('plugin-a', 'key');
      expect(value).toBe('val');
    });
  });

  // ── Corrupt or missing data.json ──────────────────────────────────────

  describe('corrupt or missing data', () => {
    it('returns empty for missing data.json (no error)', async () => {
      const value = await backend.get('no-file-plugin', 'key');
      expect(value).toBeUndefined();
    });

    it('returns empty for corrupt data.json (invalid JSON)', async () => {
      const dir = path.join(tempDir, 'plugin-data', 'corrupt-plugin');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'data.json'), '{{{ bad json', 'utf-8');

      const value = await backend.get('corrupt-plugin', 'key');
      expect(value).toBeUndefined();
    });

    it('returns empty for data.json containing an array (not object)', async () => {
      const dir = path.join(tempDir, 'plugin-data', 'array-plugin');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'data.json'), '[1, 2, 3]', 'utf-8');

      const value = await backend.get('array-plugin', 'key');
      expect(value).toBeUndefined();
    });
  });

  // ── Legacy migration ──────────────────────────────────────────────────

  describe('legacy migration', () => {
    it('migrates data from legacy electron-store on first access', async () => {
      // Set up legacy store data
      legacyStoreData = {
        version: 1,
        data: {
          'legacy-plugin': { color: 'red', count: 5 },
        },
      };

      const color = await backend.get('legacy-plugin', 'color');
      expect(color).toBe('red');

      const count = await backend.get('legacy-plugin', 'count');
      expect(count).toBe(5);

      // Verify it was written to disk
      const onDisk = await readDataFile('legacy-plugin');
      expect(onDisk).toEqual({ color: 'red', count: 5 });
    });

    it('does not re-migrate if data.json already exists', async () => {
      // Pre-existing per-plugin data on disk
      await writeDataFile('existing-plugin', { local: 'value' });

      // Legacy store has different data for same plugin
      legacyStoreData = {
        version: 1,
        data: {
          'existing-plugin': { legacy: 'old-value' },
        },
      };

      const value = await backend.get('existing-plugin', 'local');
      expect(value).toBe('value');

      // Legacy data should NOT have overwritten
      expect(await backend.get('existing-plugin', 'legacy')).toBeUndefined();
    });

    it('skips migration when legacy store has no data for plugin', async () => {
      legacyStoreData = { version: 1, data: {} };

      const value = await backend.get('no-legacy', 'key');
      expect(value).toBeUndefined();
    });

    it('skips migration when legacy store data field is missing', async () => {
      legacyStoreData = { version: 1 };

      const value = await backend.get('no-data-field', 'key');
      expect(value).toBeUndefined();
    });
  });

  // ── Backup / Restore ───────────────────────────────────────────────────

  describe('backupData', () => {
    it('copies data.json to data.backup.json', async () => {
      await backend.set('plugin-a', 'color', 'blue');
      await backend._waitForPendingFlushes();

      const backed = await backend.backupData('plugin-a');
      expect(backed).toBe(true);

      const backupPath = path.join(tempDir, 'plugin-data', 'plugin-a', 'data.backup.json');
      const raw = await fs.readFile(backupPath, 'utf-8');
      expect(JSON.parse(raw)).toEqual({ color: 'blue' });
    });

    it('returns false when no data.json exists', async () => {
      const backed = await backend.backupData('no-data-plugin');
      expect(backed).toBe(false);
    });

    it('overwrites a previous backup', async () => {
      await backend.set('plugin-a', 'v', 1);
      await backend._waitForPendingFlushes();
      await backend.backupData('plugin-a');

      await backend.set('plugin-a', 'v', 2);
      await backend._waitForPendingFlushes();
      await backend.backupData('plugin-a');

      const backupPath = path.join(tempDir, 'plugin-data', 'plugin-a', 'data.backup.json');
      const raw = await fs.readFile(backupPath, 'utf-8');
      expect(JSON.parse(raw)).toEqual({ v: 2 });
    });
  });

  describe('restoreBackup', () => {
    it('restores data from data.backup.json and reloads cache', async () => {
      // Set initial data and backup
      await backend.set('plugin-a', 'color', 'red');
      await backend._waitForPendingFlushes();
      await backend.backupData('plugin-a');

      // Overwrite data
      await backend.set('plugin-a', 'color', 'green');
      await backend._waitForPendingFlushes();

      // Restore
      const restored = await backend.restoreBackup('plugin-a');
      expect(restored).toBe(true);

      // Cache should reflect restored data
      const value = await backend.get('plugin-a', 'color');
      expect(value).toBe('red');
    });

    it('removes backup file after restoring', async () => {
      await backend.set('plugin-a', 'key', 'val');
      await backend._waitForPendingFlushes();
      await backend.backupData('plugin-a');

      await backend.restoreBackup('plugin-a');

      const backupPath = path.join(tempDir, 'plugin-data', 'plugin-a', 'data.backup.json');
      await expect(fs.access(backupPath)).rejects.toThrow();
    });

    it('returns false when no backup exists', async () => {
      const restored = await backend.restoreBackup('no-backup-plugin');
      expect(restored).toBe(false);
    });
  });

  describe('hasBackup', () => {
    it('returns true when backup file exists', async () => {
      await backend.set('plugin-a', 'key', 'val');
      await backend._waitForPendingFlushes();
      await backend.backupData('plugin-a');

      expect(await backend.hasBackup('plugin-a')).toBe(true);
    });

    it('returns false when no backup exists', async () => {
      expect(await backend.hasBackup('no-backup-plugin')).toBe(false);
    });

    it('returns false after restore consumes the backup', async () => {
      await backend.set('plugin-a', 'key', 'val');
      await backend._waitForPendingFlushes();
      await backend.backupData('plugin-a');
      await backend.restoreBackup('plugin-a');

      expect(await backend.hasBackup('plugin-a')).toBe(false);
    });
  });

  // ── Scope routing ──────────────────────────────────────────────────────

  describe('scope routing', () => {
    let sharedDir: string;

    beforeEach(async () => {
      // Create a separate shared directory to simulate a Space path
      sharedDir = path.join(tempDir, 'spaces', 'team-space', 'plugins');
      await fs.mkdir(sharedDir, { recursive: true });
    });

    it('routes data to local dir when scope resolver returns local', async () => {
      const resolver = vi.fn().mockResolvedValue({
        scope: 'local',
        dataDir: path.join(tempDir, 'plugin-data', 'local-plugin'),
      });
      backend.setScopeResolver(resolver);

      await backend.set('local-plugin', 'greeting', 'hello');
      await backend._waitForPendingFlushes();

      // Data should be in the local plugin-data directory
      const localPath = path.join(tempDir, 'plugin-data', 'local-plugin', 'data.json');
      const raw = await fs.readFile(localPath, 'utf-8');
      expect(JSON.parse(raw)).toEqual({ greeting: 'hello' });

      expect(resolver).toHaveBeenCalledWith('local-plugin');
    });

    it('routes data to shared dir when scope resolver returns shared', async () => {
      const sharedPluginDir = path.join(sharedDir, 'shared-plugin');
      const resolver = vi.fn().mockResolvedValue({
        scope: 'shared',
        dataDir: sharedPluginDir,
      });
      backend.setScopeResolver(resolver);

      await backend.set('shared-plugin', 'team-data', 'important');
      await backend._waitForPendingFlushes();

      // Data should be in the shared Space directory
      const sharedPath = path.join(sharedPluginDir, 'data.json');
      const raw = await fs.readFile(sharedPath, 'utf-8');
      expect(JSON.parse(raw)).toEqual({ 'team-data': 'important' });

      // NOT in local plugin-data directory
      const localPath = path.join(tempDir, 'plugin-data', 'shared-plugin', 'data.json');
      await expect(fs.access(localPath)).rejects.toThrow();
    });

    it('falls back to local dir when scope resolver throws', async () => {
      const resolver = vi.fn().mockRejectedValue(new Error('Space not found'));
      backend.setScopeResolver(resolver);

      await backend.set('fallback-plugin', 'key', 'val');
      await backend._waitForPendingFlushes();

      // Should fall back to local plugin-data directory
      const localPath = path.join(tempDir, 'plugin-data', 'fallback-plugin', 'data.json');
      const raw = await fs.readFile(localPath, 'utf-8');
      expect(JSON.parse(raw)).toEqual({ key: 'val' });
    });

    it('caches scope resolver result — resolver called only once per plugin', async () => {
      const resolver = vi.fn().mockResolvedValue({
        scope: 'local',
        dataDir: path.join(tempDir, 'plugin-data', 'cached-plugin'),
      });
      backend.setScopeResolver(resolver);

      // Multiple operations on the same plugin
      await backend.set('cached-plugin', 'a', 1);
      await backend.set('cached-plugin', 'b', 2);
      await backend.get('cached-plugin', 'a');
      await backend.delete('cached-plugin', 'b');

      // Resolver should have been called exactly once
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(resolver).toHaveBeenCalledWith('cached-plugin');
    });

    it('shared-scope clear() only deletes data.json, not the directory', async () => {
      const sharedPluginDir = path.join(sharedDir, 'scoped-plugin');
      await fs.mkdir(sharedPluginDir, { recursive: true });

      // Write a manifest.json to simulate plugin code files in the shared dir
      await fs.writeFile(
        path.join(sharedPluginDir, 'manifest.json'),
        JSON.stringify({ id: 'scoped-plugin', name: 'Test' }),
        'utf-8',
      );

      const resolver = vi.fn().mockResolvedValue({
        scope: 'shared',
        dataDir: sharedPluginDir,
      });
      backend.setScopeResolver(resolver);

      // Write some data
      await backend.set('scoped-plugin', 'key', 'val');
      await backend._waitForPendingFlushes();

      // Verify data.json exists
      const dataPath = path.join(sharedPluginDir, 'data.json');
      await expect(fs.access(dataPath)).resolves.toBeUndefined();

      // Clear the plugin data
      await backend.clear('scoped-plugin');

      // data.json should be deleted
      await expect(fs.access(dataPath)).rejects.toThrow();

      // But manifest.json (and the directory) should still exist
      const manifestPath = path.join(sharedPluginDir, 'manifest.json');
      await expect(fs.access(manifestPath)).resolves.toBeUndefined();
      await expect(fs.access(sharedPluginDir)).resolves.toBeUndefined();
    });

    it('local-scope clear() removes the entire plugin data directory', async () => {
      const resolver = vi.fn().mockResolvedValue({
        scope: 'local',
        dataDir: path.join(tempDir, 'plugin-data', 'local-clear-plugin'),
      });
      backend.setScopeResolver(resolver);

      await backend.set('local-clear-plugin', 'key', 'val');
      await backend._waitForPendingFlushes();

      const pluginDir = path.join(tempDir, 'plugin-data', 'local-clear-plugin');
      await expect(fs.access(pluginDir)).resolves.toBeUndefined();

      await backend.clear('local-clear-plugin');

      // Entire directory should be removed for local scope
      await expect(fs.access(pluginDir)).rejects.toThrow();
    });
  });

  // ── _resetForTests ────────────────────────────────────────────────────

  describe('_resetForTests', () => {
    it('clears all internal state', async () => {
      await backend.set('plugin-a', 'key', 'val');

      backend._resetForTests();

      // After reset, should read from disk (which was never flushed due to debounce)
      // The reset also clears baseDir, so a fresh backend starts clean
      const value = await backend.get('plugin-a', 'key');
      expect(value).toBeUndefined();
    });
  });
});
