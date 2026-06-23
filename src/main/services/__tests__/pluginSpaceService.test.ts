import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Mock settingsStore
const mockGetSettings = vi.fn();
vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => mockGetSettings(),
}));

// Mock spaceService.scanSpaces
const mockScanSpaces = vi.fn();
vi.mock('../spaceService', () => ({
  scanSpaces: (...args: unknown[]) => mockScanSpaces(...args),
}));

// Mock pluginFilePersistence
const mockLoadPersistedPluginEntries = vi.fn();
const mockPersistPluginEntries = vi.fn();
vi.mock('../pluginFilePersistence', () => ({
  loadPersistedPluginEntries: () => mockLoadPersistedPluginEntries(),
  persistPluginEntries: (...args: unknown[]) => mockPersistPluginEntries(...args),
}));

// Mock electron-store (needed by some transitive imports)
vi.mock('electron-store', () => ({
  default: class {
    store: Record<string, unknown> = {};
    get = vi.fn((key: string) => this.store[key]);
    set = vi.fn();
  },
}));

const {
  scanSpacePlugins,
  exportPluginToSpace,
  writePluginToSpace,
  generatePluginReadme,
  getChiefOfStaffPath,
  deletePluginFromSpace,
  migratePluginsToSpace,
} = await import('../pluginSpaceService');

describe('pluginSpaceService', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-plugin-space-'));
    mockGetSettings.mockReset();
    mockScanSpaces.mockReset();
    mockLoadPersistedPluginEntries.mockReset();
    mockPersistPluginEntries.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('scanSpacePlugins', () => {
    it('returns empty payload when no workspace configured', async () => {
      mockGetSettings.mockReturnValue({ coreDirectory: '' });

      const result = await scanSpacePlugins();
      expect(result).toEqual({ plugins: [], conflicts: [] });
    });

    it('discovers plugins from Space plugins/ directories', async () => {
      const spacePath = path.join(tempDir, 'MySpace');
      const pluginDir = path.join(spacePath, 'plugins', 'meeting-prep');
      await fs.mkdir(pluginDir, { recursive: true });

      // Write valid manifest and source
      await fs.writeFile(
        path.join(pluginDir, 'manifest.json'),
        JSON.stringify({ id: 'meeting-prep', name: 'Meeting Prep', entryPoint: 'index.tsx', version: '0.1.0' }),
      );
      await fs.writeFile(
        path.join(pluginDir, 'index.tsx'),
        'export default function MeetingPrep() { return null; }',
      );

      mockGetSettings.mockReturnValue({ coreDirectory: tempDir });
      mockScanSpaces.mockResolvedValue([
        { name: 'MySpace', absolutePath: spacePath, path: 'MySpace' },
      ]);

      const result = await scanSpacePlugins();
      expect(result.plugins).toHaveLength(1);
      expect(result.plugins[0].pluginId).toBe('meeting-prep');
      expect(result.plugins[0].spaceName).toBe('MySpace');
      expect(result.plugins[0].spacePath).toBe(spacePath);
      expect(result.plugins[0].source).toBe('export default function MeetingPrep() { return null; }');
      expect(result.plugins[0].manifest.id).toBe('meeting-prep');
      expect(result.plugins[0].manifest.name).toBe('Meeting Prep');
      expect(result.conflicts).toEqual([]);
    });

    it('includes conflict metadata when plugin conflict files are present', async () => {
      const spacePath = path.join(tempDir, 'MySpace');
      const pluginDir = path.join(spacePath, 'plugins', 'meeting-prep');
      await fs.mkdir(pluginDir, { recursive: true });

      await Promise.all([
        fs.writeFile(
          path.join(pluginDir, 'manifest.json'),
          JSON.stringify({ id: 'meeting-prep', name: 'Meeting Prep', entryPoint: 'index.tsx', version: '0.1.0' }),
        ),
        fs.writeFile(path.join(pluginDir, 'index.tsx'), 'export default function MeetingPrep() { return null; }'),
        fs.writeFile(path.join(pluginDir, 'manifest (1).json'), JSON.stringify({ id: 'meeting-prep', name: 'Conflict' })),
      ]);

      mockGetSettings.mockReturnValue({ coreDirectory: tempDir });
      mockScanSpaces.mockResolvedValue([
        { name: 'MySpace', absolutePath: spacePath, path: 'MySpace' },
      ]);

      const result = await scanSpacePlugins();

      expect(result.plugins).toHaveLength(1);
      expect(result.conflicts).toEqual([
        {
          pluginId: 'meeting-prep',
          conflictFiles: ['manifest (1).json'],
          spacePath,
        },
      ]);
    });

    it('skips directories without manifest.json', async () => {
      const spacePath = path.join(tempDir, 'MySpace');
      const pluginDir = path.join(spacePath, 'plugins', 'no-manifest');
      await fs.mkdir(pluginDir, { recursive: true });

      // Only write source, no manifest
      await fs.writeFile(path.join(pluginDir, 'index.tsx'), 'export default function() {}');

      mockGetSettings.mockReturnValue({ coreDirectory: tempDir });
      mockScanSpaces.mockResolvedValue([
        { name: 'MySpace', absolutePath: spacePath, path: 'MySpace' },
      ]);

      const result = await scanSpacePlugins();
      expect(result.plugins).toHaveLength(0);
      expect(result.conflicts).toEqual([]);
    });

    it('skips directories with invalid JSON manifest', async () => {
      const spacePath = path.join(tempDir, 'MySpace');
      const pluginDir = path.join(spacePath, 'plugins', 'bad-json');
      await fs.mkdir(pluginDir, { recursive: true });

      await fs.writeFile(path.join(pluginDir, 'manifest.json'), '{ invalid json }}}');
      await fs.writeFile(path.join(pluginDir, 'index.tsx'), 'export default function() {}');

      mockGetSettings.mockReturnValue({ coreDirectory: tempDir });
      mockScanSpaces.mockResolvedValue([
        { name: 'MySpace', absolutePath: spacePath, path: 'MySpace' },
      ]);

      const result = await scanSpacePlugins();
      expect(result.plugins).toHaveLength(0);
      expect(result.conflicts).toEqual([]);
    });

    it('skips directories without index.tsx', async () => {
      const spacePath = path.join(tempDir, 'MySpace');
      const pluginDir = path.join(spacePath, 'plugins', 'no-source');
      await fs.mkdir(pluginDir, { recursive: true });

      // Only write manifest, no source
      await fs.writeFile(
        path.join(pluginDir, 'manifest.json'),
        JSON.stringify({ id: 'no-source', name: 'No Source', entryPoint: 'index.tsx' }),
      );

      mockGetSettings.mockReturnValue({ coreDirectory: tempDir });
      mockScanSpaces.mockResolvedValue([
        { name: 'MySpace', absolutePath: spacePath, path: 'MySpace' },
      ]);

      const result = await scanSpacePlugins();
      expect(result.plugins).toHaveLength(0);
      expect(result.conflicts).toEqual([]);
    });

    it('handles missing plugins/ directory gracefully', async () => {
      const spacePath = path.join(tempDir, 'MySpace');
      await fs.mkdir(spacePath, { recursive: true });
      // No plugins/ directory at all

      mockGetSettings.mockReturnValue({ coreDirectory: tempDir });
      mockScanSpaces.mockResolvedValue([
        { name: 'MySpace', absolutePath: spacePath, path: 'MySpace' },
      ]);

      const result = await scanSpacePlugins();
      expect(result.plugins).toHaveLength(0);
      expect(result.conflicts).toEqual([]);
    });

    it('skips manifest missing required id field', async () => {
      const spacePath = path.join(tempDir, 'MySpace');
      const pluginDir = path.join(spacePath, 'plugins', 'no-id');
      await fs.mkdir(pluginDir, { recursive: true });

      await fs.writeFile(
        path.join(pluginDir, 'manifest.json'),
        JSON.stringify({ name: 'Missing ID' }),
      );
      await fs.writeFile(path.join(pluginDir, 'index.tsx'), 'export default function() {}');

      mockGetSettings.mockReturnValue({ coreDirectory: tempDir });
      mockScanSpaces.mockResolvedValue([
        { name: 'MySpace', absolutePath: spacePath, path: 'MySpace' },
      ]);

      const result = await scanSpacePlugins();
      expect(result.plugins).toHaveLength(0);
      expect(result.conflicts).toEqual([]);
    });

    it('defaults entryPoint to index.tsx when not in manifest', async () => {
      const spacePath = path.join(tempDir, 'MySpace');
      const pluginDir = path.join(spacePath, 'plugins', 'test-plugin');
      await fs.mkdir(pluginDir, { recursive: true });

      await fs.writeFile(
        path.join(pluginDir, 'manifest.json'),
        JSON.stringify({ id: 'test-plugin', name: 'Test Plugin' }),
      );
      await fs.writeFile(path.join(pluginDir, 'index.tsx'), 'export default function() {}');

      mockGetSettings.mockReturnValue({ coreDirectory: tempDir });
      mockScanSpaces.mockResolvedValue([
        { name: 'MySpace', absolutePath: spacePath, path: 'MySpace' },
      ]);

      const result = await scanSpacePlugins();
      expect(result.plugins).toHaveLength(1);
      expect(result.plugins[0].manifest.entryPoint).toBe('index.tsx');
      expect(result.conflicts).toEqual([]);
    });
  });

  describe('exportPluginToSpace', () => {
    it('creates folder structure correctly', async () => {
      mockLoadPersistedPluginEntries.mockReturnValue([
        {
          manifest: {
            id: 'meeting-prep',
            name: 'Meeting Prep',
            description: 'Prepare for meetings',
            version: '1.0.0',
            entryPoint: 'index.tsx',
            maturity: 'stable',
            createdBy: 'user@example.com',
          },
          source: 'export default function MeetingPrep() { return null; }',
        },
      ]);

      const result = await exportPluginToSpace('meeting-prep', tempDir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.exportedPath).toBe(path.join(tempDir, 'plugins', 'meeting-prep'));
      }

      // Verify files were written
      const manifestContent = await fs.readFile(
        path.join(tempDir, 'plugins', 'meeting-prep', 'manifest.json'),
        'utf-8',
      );
      const manifest = JSON.parse(manifestContent);
      expect(manifest.id).toBe('meeting-prep');
      expect(manifest.name).toBe('Meeting Prep');
      expect(manifest.version).toBe('1.0.0');

      const sourceContent = await fs.readFile(
        path.join(tempDir, 'plugins', 'meeting-prep', 'index.tsx'),
        'utf-8',
      );
      expect(sourceContent).toBe('export default function MeetingPrep() { return null; }');
    });

    it('returns error for non-existent plugin', async () => {
      mockLoadPersistedPluginEntries.mockReturnValue([]);

      const result = await exportPluginToSpace('nonexistent', tempDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('not found');
      }
    });

    it('excludes createdBy from shared manifest', async () => {
      mockLoadPersistedPluginEntries.mockReturnValue([
        {
          manifest: {
            id: 'test-plugin',
            name: 'Test',
            entryPoint: 'index.tsx',
            version: '0.1.0',
            maturity: 'labs',
            createdBy: '[external-email]',
          },
          source: 'export default function() {}',
        },
      ]);

      const result = await exportPluginToSpace('test-plugin', tempDir);
      expect(result.ok).toBe(true);

      const manifestContent = await fs.readFile(
        path.join(tempDir, 'plugins', 'test-plugin', 'manifest.json'),
        'utf-8',
      );
      const manifest = JSON.parse(manifestContent);
      expect(manifest.createdBy).toBeUndefined();
      expect(manifest.id).toBe('test-plugin');
    });
  });

  describe('writePluginToSpace', () => {
    it('writes manifest.json and index.tsx to plugins/{id}/', async () => {
      const manifest = {
        id: 'my-plugin',
        name: 'My Plugin',
        description: 'A test plugin',
        version: '1.0.0',
        entryPoint: 'index.tsx',
        maturity: 'labs',
      };
      const source = 'export default function MyPlugin() { return null; }';

      const result = await writePluginToSpace(manifest, source, tempDir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.exportedPath).toBe(path.join(tempDir, 'plugins', 'my-plugin'));
      }

      const manifestContent = await fs.readFile(
        path.join(tempDir, 'plugins', 'my-plugin', 'manifest.json'),
        'utf-8',
      );
      const parsed = JSON.parse(manifestContent);
      expect(parsed.id).toBe('my-plugin');
      expect(parsed.name).toBe('My Plugin');
      expect(parsed.version).toBe('1.0.0');

      const sourceContent = await fs.readFile(
        path.join(tempDir, 'plugins', 'my-plugin', 'index.tsx'),
        'utf-8',
      );
      expect(sourceContent).toBe(source);

      const readmeContent = await fs.readFile(
        path.join(tempDir, 'plugins', 'my-plugin', 'README.md'),
        'utf-8',
      );
      expect(readmeContent).toContain('# My Plugin');
      expect(readmeContent).toContain('> Plugin ID: `my-plugin`');
      expect(readmeContent).toContain('A test plugin');
      expect(readmeContent).toContain('## Version');
      expect(readmeContent).toContain('v1.0.0');
    });

    it('creates plugins/ directory recursively', async () => {
      const manifest = { id: 'nested-plugin', name: 'Nested', version: '0.1.0' };
      const source = 'export default function() {}';

      const result = await writePluginToSpace(manifest, source, tempDir);
      expect(result.ok).toBe(true);

      const stat = await fs.stat(path.join(tempDir, 'plugins', 'nested-plugin'));
      expect(stat.isDirectory()).toBe(true);
    });

    it('excludes createdBy from written manifest', async () => {
      const manifest = {
        id: 'private-plugin',
        name: 'Private',
        createdBy: '[external-email]',
        version: '0.1.0',
      };
      const source = 'export default function() {}';

      const result = await writePluginToSpace(manifest, source, tempDir);
      expect(result.ok).toBe(true);

      const manifestContent = await fs.readFile(
        path.join(tempDir, 'plugins', 'private-plugin', 'manifest.json'),
        'utf-8',
      );
      const parsed = JSON.parse(manifestContent);
      expect(parsed.createdBy).toBeUndefined();
    });

    it('returns error when manifest has no id', async () => {
      const manifest = { name: 'No ID' };
      const source = 'export default function() {}';

      const result = await writePluginToSpace(manifest, source, tempDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('id');
      }
    });

    it('overwrites existing plugin files', async () => {
      const manifest = { id: 'overwrite-test', name: 'Version 1', version: '0.1.0' };

      await writePluginToSpace(manifest, 'v1 source', tempDir);
      await writePluginToSpace({ ...manifest, name: 'Version 2', version: '0.2.0' }, 'v2 source', tempDir);

      const manifestContent = await fs.readFile(
        path.join(tempDir, 'plugins', 'overwrite-test', 'manifest.json'),
        'utf-8',
      );
      const parsed = JSON.parse(manifestContent);
      expect(parsed.name).toBe('Version 2');
      expect(parsed.version).toBe('0.2.0');

      const sourceContent = await fs.readFile(
        path.join(tempDir, 'plugins', 'overwrite-test', 'index.tsx'),
        'utf-8',
      );
      expect(sourceContent).toBe('v2 source');
    });

    it('writes readmeOverride when provided and generated README when omitted', async () => {
      const manifest = {
        id: 'readme-override-test',
        name: 'Readme Override Test',
        description: 'Description from manifest',
        version: '1.2.3',
      };
      const source = 'export default function ReadmeOverrideTest() { return null; }';
      const readmeOverride = 'CUSTOM README CONTENT';

      const overrideResult = await writePluginToSpace(manifest, source, tempDir, { readmeOverride });
      expect(overrideResult.ok).toBe(true);

      const overrideReadmePath = path.join(tempDir, 'plugins', 'readme-override-test', 'README.md');
      await expect(fs.readFile(overrideReadmePath, 'utf-8')).resolves.toBe(readmeOverride);

      const generatedManifest = {
        id: 'readme-generated-test',
        name: 'Readme Generated Test',
        description: 'Generated README description',
        version: '4.5.6',
      };
      const generatedResult = await writePluginToSpace(generatedManifest, source, tempDir);
      expect(generatedResult.ok).toBe(true);

      const generatedReadmePath = path.join(tempDir, 'plugins', 'readme-generated-test', 'README.md');
      const generatedReadme = await fs.readFile(generatedReadmePath, 'utf-8');
      const expectedReadme = generatePluginReadme(generatedManifest);
      expect(generatedReadme).toBe(expectedReadme);
    });
  });

  describe('generatePluginReadme', () => {
    it('generates a minimal README from required manifest fields', () => {
      const readme = generatePluginReadme({
        id: 'minimal-plugin',
        name: 'Minimal Plugin',
      });

      expect(readme).toContain('# Minimal Plugin');
      expect(readme).toContain('> Plugin ID: `minimal-plugin`');
      expect(readme).toContain('## Version');
      expect(readme).toContain('v0.1.0');
      expect(readme).not.toContain('## Documentation');
      expect(readme).not.toContain('## Changelog');
      expect(readme).not.toContain('undefined');
    });

    it('includes description and documentation when present', () => {
      const readme = generatePluginReadme({
        id: 'full-plugin',
        name: 'Full Plugin',
        description: 'Helps with project planning.',
        documentation: 'Use this plugin to create structured planning notes.',
        version: '2.3.4',
      });

      expect(readme).toContain('# Full Plugin');
      expect(readme).toContain('> Plugin ID: `full-plugin`');
      expect(readme).toContain('Helps with project planning.');
      expect(readme).toContain('## Documentation');
      expect(readme).toContain('Use this plugin to create structured planning notes.');
      expect(readme).toContain('v2.3.4');
      expect(readme).not.toContain('undefined');
    });

    it('formats changelog entries as markdown list items', () => {
      const readme = generatePluginReadme({
        id: 'changelog-plugin',
        name: 'Changelog Plugin',
        changelog: [
          { version: '1.2.0', changes: 'Added better summaries.' },
          { version: '1.1.0', summary: 'Fixed edge-case handling.' },
          { changes: 'General cleanup and polish.' },
        ],
      });

      expect(readme).toContain('## Changelog');
      expect(readme).toContain('- **v1.2.0**: Added better summaries.');
      expect(readme).toContain('- **v1.1.0**: Fixed edge-case handling.');
      expect(readme).toContain('- General cleanup and polish.');
      expect(readme).not.toContain('undefined');
    });

    it('omits optional documentation and changelog sections cleanly when missing', () => {
      const readme = generatePluginReadme({
        id: 'no-optional-sections',
        name: 'No Optional Sections',
        description: 'Description only.',
        version: '3.0.0',
      });

      expect(readme).toContain('Description only.');
      expect(readme).toContain('v3.0.0');
      expect(readme).not.toContain('## Documentation');
      expect(readme).not.toContain('## Changelog');
      expect(readme).not.toContain('undefined');
    });
  });

  describe('getChiefOfStaffPath', () => {
    it('returns path when Chief-of-Staff directory exists', async () => {
      const chiefDir = path.join(tempDir, 'Chief-of-Staff');
      await fs.mkdir(chiefDir);

      mockGetSettings.mockReturnValue({ coreDirectory: tempDir });

      const result = await getChiefOfStaffPath();
      expect(result).toBe(chiefDir);
    });

    it('finds Chief-of-Staff case-insensitively', async () => {
      const chiefDir = path.join(tempDir, 'chief-of-staff');
      await fs.mkdir(chiefDir);

      mockGetSettings.mockReturnValue({ coreDirectory: tempDir });

      const result = await getChiefOfStaffPath();
      expect(result).toBe(chiefDir);
    });

    it('returns null when no workspace configured', async () => {
      mockGetSettings.mockReturnValue({ coreDirectory: '' });

      const result = await getChiefOfStaffPath();
      expect(result).toBeNull();
    });

    it('returns null when Chief-of-Staff does not exist', async () => {
      mockGetSettings.mockReturnValue({ coreDirectory: tempDir });

      const result = await getChiefOfStaffPath();
      expect(result).toBeNull();
    });
  });

  describe('deletePluginFromSpace', () => {
    it('deletes an existing plugin folder', async () => {
      const pluginDir = path.join(tempDir, 'plugins', 'doomed-plugin');
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(path.join(pluginDir, 'manifest.json'), '{}');
      await fs.writeFile(path.join(pluginDir, 'index.tsx'), '');

      const result = await deletePluginFromSpace('doomed-plugin', tempDir);
      expect(result).toBe(true);

      await expect(fs.stat(pluginDir)).rejects.toThrow();
    });

    it('returns false when plugin folder does not exist', async () => {
      const result = await deletePluginFromSpace('nonexistent', tempDir);
      // force: true means rm doesn't throw for nonexistent, so this returns true
      expect(result).toBe(true);
    });
  });

  describe('migratePluginsToSpace', () => {
    it('returns zeros when electron-store is empty', async () => {
      mockGetSettings.mockReturnValue({ coreDirectory: tempDir });
      mockLoadPersistedPluginEntries.mockReturnValue([]);

      const result = await migratePluginsToSpace();
      expect(result).toEqual({ migrated: 0, skipped: 0, failed: 0 });
      expect(mockPersistPluginEntries).not.toHaveBeenCalled();
    });

    it('returns zeros when no workspace is configured', async () => {
      mockGetSettings.mockReturnValue({ coreDirectory: '' });
      mockLoadPersistedPluginEntries.mockReturnValue([
        {
          manifest: { id: 'test-plugin', name: 'Test', entryPoint: 'index.tsx', version: '0.1.0' },
          source: 'export default function() {}',
        },
      ]);

      const result = await migratePluginsToSpace();
      expect(result).toEqual({ migrated: 0, skipped: 0, failed: 0 });
      expect(mockPersistPluginEntries).not.toHaveBeenCalled();
    });

    it('migrates plugins to Chief-of-Staff when it exists', async () => {
      // Create Chief-of-Staff directory
      const cosPath = path.join(tempDir, 'Chief-of-Staff');
      await fs.mkdir(path.join(cosPath, 'plugins'), { recursive: true });

      mockGetSettings.mockReturnValue({ coreDirectory: tempDir });
      mockLoadPersistedPluginEntries.mockReturnValue([
        {
          manifest: { id: 'meeting-prep', name: 'Meeting Prep', entryPoint: 'index.tsx', version: '1.0.0' },
          source: 'export default function MeetingPrep() { return null; }',
        },
      ]);

      const result = await migratePluginsToSpace();
      expect(result).toEqual({ migrated: 1, skipped: 0, failed: 0 });

      // Verify files were written
      const manifestContent = await fs.readFile(
        path.join(cosPath, 'plugins', 'meeting-prep', 'manifest.json'),
        'utf-8',
      );
      const manifest = JSON.parse(manifestContent);
      expect(manifest.id).toBe('meeting-prep');
      expect(manifest.name).toBe('Meeting Prep');

      const sourceContent = await fs.readFile(
        path.join(cosPath, 'plugins', 'meeting-prep', 'index.tsx'),
        'utf-8',
      );
      expect(sourceContent).toBe('export default function MeetingPrep() { return null; }');

      // Verify electron-store was cleared (empty remaining)
      expect(mockPersistPluginEntries).toHaveBeenCalledWith([]);
    });

    it('creates Chief-of-Staff/plugins/ if it does not exist', async () => {
      // No Chief-of-Staff directory in workspace
      mockGetSettings.mockReturnValue({ coreDirectory: tempDir });
      mockLoadPersistedPluginEntries.mockReturnValue([
        {
          manifest: { id: 'my-plugin', name: 'My Plugin', entryPoint: 'index.tsx', version: '0.1.0' },
          source: 'export default function() {}',
        },
      ]);

      const result = await migratePluginsToSpace();
      expect(result).toEqual({ migrated: 1, skipped: 0, failed: 0 });

      // Verify Chief-of-Staff was created
      const stat = await fs.stat(path.join(tempDir, 'Chief-of-Staff', 'plugins', 'my-plugin'));
      expect(stat.isDirectory()).toBe(true);

      expect(mockPersistPluginEntries).toHaveBeenCalledWith([]);
    });

    it('skips plugins that already exist in Chief-of-Staff (CoS wins)', async () => {
      const cosPath = path.join(tempDir, 'Chief-of-Staff');
      const existingPluginDir = path.join(cosPath, 'plugins', 'existing-plugin');
      await fs.mkdir(existingPluginDir, { recursive: true });
      await fs.writeFile(
        path.join(existingPluginDir, 'manifest.json'),
        JSON.stringify({ id: 'existing-plugin', name: 'CoS Version', version: '2.0.0' }),
      );
      await fs.writeFile(path.join(existingPluginDir, 'index.tsx'), 'CoS source');

      mockGetSettings.mockReturnValue({ coreDirectory: tempDir });
      mockLoadPersistedPluginEntries.mockReturnValue([
        {
          manifest: { id: 'existing-plugin', name: 'Store Version', entryPoint: 'index.tsx', version: '1.0.0' },
          source: 'electron-store source',
        },
      ]);

      const result = await migratePluginsToSpace();
      expect(result).toEqual({ migrated: 0, skipped: 1, failed: 0 });

      // Verify CoS file was NOT overwritten
      const manifestContent = await fs.readFile(
        path.join(existingPluginDir, 'manifest.json'),
        'utf-8',
      );
      const manifest = JSON.parse(manifestContent);
      expect(manifest.name).toBe('CoS Version');
      expect(manifest.version).toBe('2.0.0');

      // Skipped entries are also cleared from electron-store (already safe in CoS)
      expect(mockPersistPluginEntries).toHaveBeenCalledWith([]);
    });

    it('handles mixed success: migrates some, skips existing, keeps failed', async () => {
      const cosPath = path.join(tempDir, 'Chief-of-Staff');
      const existingPluginDir = path.join(cosPath, 'plugins', 'existing');
      await fs.mkdir(existingPluginDir, { recursive: true });
      await fs.writeFile(
        path.join(existingPluginDir, 'manifest.json'),
        JSON.stringify({ id: 'existing', name: 'Existing' }),
      );

      mockGetSettings.mockReturnValue({ coreDirectory: tempDir });

      const newPlugin = {
        manifest: { id: 'new-plugin', name: 'New Plugin', entryPoint: 'index.tsx', version: '0.1.0' },
        source: 'export default function() {}',
      };
      const existingPlugin = {
        manifest: { id: 'existing', name: 'Existing Store', entryPoint: 'index.tsx', version: '0.1.0' },
        source: 'existing source',
      };
      // Plugin with missing id will fail writePluginToSpace
      const badPlugin = {
        manifest: { id: '', name: 'Bad Plugin', entryPoint: 'index.tsx', version: '0.1.0' },
        source: 'bad source',
      };

      mockLoadPersistedPluginEntries.mockReturnValue([newPlugin, existingPlugin, badPlugin]);

      const result = await migratePluginsToSpace();
      expect(result.migrated).toBe(1); // new-plugin
      expect(result.skipped).toBe(1);  // existing
      expect(result.failed).toBe(1);   // bad plugin

      // Migrated and skipped entries are cleared; only failed entries remain
      expect(mockPersistPluginEntries).toHaveBeenCalledWith([badPlugin]);
    });

    it('migrates multiple plugins successfully', async () => {
      const cosPath = path.join(tempDir, 'Chief-of-Staff');
      await fs.mkdir(path.join(cosPath, 'plugins'), { recursive: true });

      mockGetSettings.mockReturnValue({ coreDirectory: tempDir });
      mockLoadPersistedPluginEntries.mockReturnValue([
        {
          manifest: { id: 'plugin-a', name: 'Plugin A', entryPoint: 'index.tsx', version: '0.1.0' },
          source: 'source A',
        },
        {
          manifest: { id: 'plugin-b', name: 'Plugin B', entryPoint: 'index.tsx', version: '0.2.0' },
          source: 'source B',
        },
      ]);

      const result = await migratePluginsToSpace();
      expect(result).toEqual({ migrated: 2, skipped: 0, failed: 0 });

      // Both plugins written
      const manifestA = JSON.parse(
        await fs.readFile(path.join(cosPath, 'plugins', 'plugin-a', 'manifest.json'), 'utf-8'),
      );
      expect(manifestA.id).toBe('plugin-a');

      const manifestB = JSON.parse(
        await fs.readFile(path.join(cosPath, 'plugins', 'plugin-b', 'manifest.json'), 'utf-8'),
      );
      expect(manifestB.id).toBe('plugin-b');

      // All cleared from electron-store
      expect(mockPersistPluginEntries).toHaveBeenCalledWith([]);
    });
  });
});
