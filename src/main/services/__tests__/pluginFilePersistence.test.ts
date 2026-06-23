import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

let tempDir: string;

vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: () => tempDir,
  isPackaged: () => false,
}));

import {
  loadPersistedPluginEntries,
  persistPluginEntries,
  clearPersistedPluginEntries,
  deleteSinglePlugin,
  _resetPluginFilePersistenceForTests,
} from '../pluginFilePersistence';

// ── Helpers ──────────────────────────────────────────────────────────────

function makePlugin(id: string, source = 'export default function Plugin() { return null; }'): any {
  return {
    manifest: {
      id,
      name: `Plugin ${id}`,
      entryPoint: 'inline',
      version: '0.1.0',
      maturity: 'labs',
    },
    source,
  };
}

async function writePluginDir(
  pluginId: string,
  manifest: Record<string, unknown>,
  source: string,
) {
  const pluginDir = path.join(tempDir, 'plugins', pluginId);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, 'manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(pluginDir, 'index.tsx'), source);
  return pluginDir;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('pluginFilePersistence', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-plugin-fp-'));
    _resetPluginFilePersistenceForTests();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  // ── loadPersistedPluginEntries ──────────────────────────────────────

  describe('loadPersistedPluginEntries', () => {
    it('returns empty array when plugins dir does not exist', async () => {
      const result = await loadPersistedPluginEntries();
      expect(result).toEqual([]);
    });

    it('skips plugins with corrupt manifest.json', async () => {
      const pluginDir = path.join(tempDir, 'plugins', 'corrupt');
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(path.join(pluginDir, 'manifest.json'), '{{{ not json');
      await fs.writeFile(path.join(pluginDir, 'index.tsx'), 'source');

      const result = await loadPersistedPluginEntries();
      expect(result).toEqual([]);
    });

    it('skips plugins with missing index.tsx', async () => {
      const pluginDir = path.join(tempDir, 'plugins', 'no-source');
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(
        path.join(pluginDir, 'manifest.json'),
        JSON.stringify({ id: 'no-source', name: 'No Source', entryPoint: 'inline' }),
      );
      // No index.tsx written

      const result = await loadPersistedPluginEntries();
      expect(result).toEqual([]);
    });

    it('cleans orphaned .tmp- files during load', async () => {
      const pluginDir = await writePluginDir(
        'has-orphans',
        { id: 'has-orphans', name: 'Has Orphans', entryPoint: 'inline' },
        'export default function Plugin() { return null; }',
      );

      // Create orphaned temp files
      await fs.writeFile(path.join(pluginDir, 'manifest.json.tmp-12345'), 'stale');
      await fs.writeFile(path.join(pluginDir, 'index.tsx.tmp-99999'), 'stale');

      const result = await loadPersistedPluginEntries();
      expect(result).toHaveLength(1);
      expect(result[0].manifest.id).toBe('has-orphans');

      // Verify orphan files were cleaned
      const remaining = await fs.readdir(pluginDir);
      expect(remaining.filter((f) => f.includes('.tmp-'))).toEqual([]);
      expect(remaining).toContain('manifest.json');
      expect(remaining).toContain('index.tsx');
    });
  });

  // ── persistPluginEntries + loadPersistedPluginEntries round-trip ────

  describe('persist + load round-trip', () => {
    it('persists entries and loads them back', async () => {
      const entries = [
        makePlugin('meeting-prep'),
        makePlugin('inbox-triage', 'export default function InboxTriage() { return null; }'),
      ];

      await persistPluginEntries(entries);
      const loaded = await loadPersistedPluginEntries();

      expect(loaded).toHaveLength(2);

      const ids = loaded.map((p) => p.manifest.id).sort();
      expect(ids).toEqual(['inbox-triage', 'meeting-prep']);

      const meetingPrep = loaded.find((p) => p.manifest.id === 'meeting-prep');
      expect(meetingPrep?.source).toBe('export default function Plugin() { return null; }');
      // Zod defaults applied
      expect(meetingPrep?.manifest.version).toBe('0.1.0');
      expect(meetingPrep?.manifest.maturity).toBe('labs');
    });
  });

  // ── Reconciliation ──────────────────────────────────────────────────

  describe('persistPluginEntries reconciliation', () => {
    it('removes stale plugin directories not in the new entries', async () => {
      // Persist three plugins
      await persistPluginEntries([
        makePlugin('keep-a'),
        makePlugin('keep-b'),
        makePlugin('remove-me'),
      ]);

      // Persist only two — remove-me should be gone
      await persistPluginEntries([
        makePlugin('keep-a'),
        makePlugin('keep-b'),
      ]);

      const loaded = await loadPersistedPluginEntries();
      const ids = loaded.map((p) => p.manifest.id).sort();
      expect(ids).toEqual(['keep-a', 'keep-b']);

      // Verify directory was removed
      const baseDir = path.join(tempDir, 'plugins');
      const dirs = await fs.readdir(baseDir);
      expect(dirs.sort()).toEqual(['keep-a', 'keep-b']);
    });
  });

  // ── Invalid entries ──────────────────────────────────────────────────

  describe('persistPluginEntries skips invalid entries', () => {
    it('skips entries that fail Zod validation and writes valid ones', async () => {
      const entries = [
        makePlugin('valid-plugin'),
        {
          manifest: {
            id: 'INVALID_ID', // uppercase violates regex
            name: 'Invalid',
            entryPoint: 'inline',
          },
          source: 'source',
        },
      ];

      await persistPluginEntries(entries);
      const loaded = await loadPersistedPluginEntries();

      expect(loaded).toHaveLength(1);
      expect(loaded[0].manifest.id).toBe('valid-plugin');
    });
  });

  // ── clearPersistedPluginEntries ─────────────────────────────────────

  describe('clearPersistedPluginEntries', () => {
    it('removes all plugin directories', async () => {
      await persistPluginEntries([
        makePlugin('plugin-a'),
        makePlugin('plugin-b'),
      ]);

      await clearPersistedPluginEntries();

      const loaded = await loadPersistedPluginEntries();
      expect(loaded).toEqual([]);
    });

    it('does not throw when plugins dir does not exist', async () => {
      // No plugins persisted — should not throw
      await expect(clearPersistedPluginEntries()).resolves.toBeUndefined();
    });
  });

  // ── deleteSinglePlugin ──────────────────────────────────────────────

  describe('deleteSinglePlugin', () => {
    it('removes a single plugin directory', async () => {
      await persistPluginEntries([
        makePlugin('keep-this'),
        makePlugin('delete-this'),
      ]);

      await deleteSinglePlugin('delete-this');

      const loaded = await loadPersistedPluginEntries();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].manifest.id).toBe('keep-this');
    });

    it('does not throw when plugin does not exist', async () => {
      await expect(deleteSinglePlugin('nonexistent')).resolves.toBeUndefined();
    });
  });
});
