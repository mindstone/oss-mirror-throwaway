import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const mockGetSettings = vi.fn();
vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => mockGetSettings(),
}));

const mockGetSystemSettingsPath = vi.fn();
vi.mock('../systemSettingsSync', () => ({
  getSystemSettingsPath: () => mockGetSystemSettingsPath(),
}));

vi.mock('electron-store', () => ({
  default: class {
    store: Record<string, unknown> = {};
    get = vi.fn((key: string) => this.store[key]);
    set = vi.fn();
  },
}));

const {
  seedBundledPluginsToSpace,
} = await import('../bundledPluginsService');

interface WriteBundledPluginFixtureOptions {
  id: string;
  name?: string;
  readme?: string | null;
  source?: string;
  writeIndex?: boolean;
  manifestOverride?: Record<string, unknown>;
  rawManifest?: string;
}

describe('bundledPluginsService', () => {
  let tempDir: string;
  let bundledRoot: string;
  let workspacePath: string;
  let cosPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-bundled-plugins-'));
    bundledRoot = path.join(tempDir, 'system-settings');
    workspacePath = path.join(tempDir, 'workspace');
    cosPath = path.join(workspacePath, 'Chief-of-Staff');

    await fs.mkdir(bundledRoot, { recursive: true });
    await fs.mkdir(workspacePath, { recursive: true });

    mockGetSettings.mockReset();
    mockGetSystemSettingsPath.mockReset();
    mockGetSettings.mockReturnValue({ coreDirectory: workspacePath });
    mockGetSystemSettingsPath.mockReturnValue(bundledRoot);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  async function writeBundledPluginFixture(options: WriteBundledPluginFixtureOptions): Promise<void> {
    const pluginDir = path.join(bundledRoot, 'plugins', options.id);
    await fs.mkdir(pluginDir, { recursive: true });

    const manifest = options.manifestOverride ?? {
      id: options.id,
      name: options.name ?? options.id,
      entryPoint: 'index.tsx',
    };
    await fs.writeFile(
      path.join(pluginDir, 'manifest.json'),
      options.rawManifest ?? JSON.stringify(manifest, null, 2),
      'utf-8',
    );

    if (options.writeIndex !== false) {
      await fs.writeFile(
        path.join(pluginDir, 'index.tsx'),
        options.source ?? `export default function ${options.id.replace(/-/g, '')}() { return null; }`,
        'utf-8',
      );
    }

    if (options.readme !== null) {
      await fs.writeFile(path.join(pluginDir, 'README.md'), options.readme ?? `README ${options.id}`, 'utf-8');
    }
  }

  async function listSeededPluginDirs(): Promise<string[]> {
    const pluginsDir = path.join(cosPath, 'plugins');
    try {
      const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    } catch {
      return [];
    }
  }

  it('seeds all bundled plugins on a fresh run and preserves bundled README files', async () => {
    await writeBundledPluginFixture({ id: 'pomodoro-timer', name: 'Focus Timer', readme: 'README: Focus Timer' });
    await writeBundledPluginFixture({ id: 'research-hub', name: 'Research Hub', readme: 'README: Research Hub' });
    await writeBundledPluginFixture({ id: 'sources-browser', name: 'My Sources', readme: 'README: My Sources' });

    const result = await seedBundledPluginsToSpace({ alreadySeededIds: [] });

    expect(result.seeded.slice().sort()).toEqual(['pomodoro-timer', 'research-hub', 'sources-browser']);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.malformed).toEqual([]);

    await expect(
      fs.readFile(path.join(cosPath, 'plugins', 'pomodoro-timer', 'README.md'), 'utf-8'),
    ).resolves.toBe('README: Focus Timer');
    await expect(
      fs.readFile(path.join(cosPath, 'plugins', 'research-hub', 'README.md'), 'utf-8'),
    ).resolves.toBe('README: Research Hub');
    await expect(
      fs.readFile(path.join(cosPath, 'plugins', 'sources-browser', 'README.md'), 'utf-8'),
    ).resolves.toBe('README: My Sources');
  });

  it('skips ids already marked seeded', async () => {
    await writeBundledPluginFixture({ id: 'pomodoro-timer', name: 'Focus Timer' });
    await writeBundledPluginFixture({ id: 'research-hub', name: 'Research Hub' });
    await writeBundledPluginFixture({ id: 'sources-browser', name: 'My Sources' });

    const result = await seedBundledPluginsToSpace({ alreadySeededIds: ['pomodoro-timer'] });

    expect(result.seeded).toHaveLength(2);
    expect(result.skipped).toEqual(['pomodoro-timer']);
    expect(result.failed).toEqual([]);
    expect(result.malformed).toEqual([]);
    await expect(listSeededPluginDirs()).resolves.toEqual(['research-hub', 'sources-browser']);
  });

  it('skips overwrite when Chief-of-Staff already has a valid plugin copy', async () => {
    await writeBundledPluginFixture({
      id: 'pomodoro-timer',
      name: 'Focus Timer',
      source: 'export default function bundledVersion() { return null; }',
      readme: 'BUNDLED README',
    });

    const existingPluginDir = path.join(cosPath, 'plugins', 'pomodoro-timer');
    await fs.mkdir(existingPluginDir, { recursive: true });
    await fs.writeFile(
      path.join(existingPluginDir, 'manifest.json'),
      JSON.stringify({ id: 'pomodoro-timer', name: 'Custom Timer', entryPoint: 'index.tsx' }, null, 2),
      'utf-8',
    );
    await fs.writeFile(
      path.join(existingPluginDir, 'index.tsx'),
      'export default function userVersion() { return "user"; }',
      'utf-8',
    );

    const result = await seedBundledPluginsToSpace({ alreadySeededIds: [] });

    expect(result).toEqual({
      seeded: [],
      skipped: ['pomodoro-timer'],
      failed: [],
      malformed: [],
    });
    await expect(
      fs.readFile(path.join(existingPluginDir, 'manifest.json'), 'utf-8'),
    ).resolves.toContain('"name": "Custom Timer"');
    await expect(
      fs.readFile(path.join(existingPluginDir, 'index.tsx'), 'utf-8'),
    ).resolves.toBe('export default function userVersion() { return "user"; }');
  });

  it('self-heals half-written Chief-of-Staff plugins by re-seeding', async () => {
    await writeBundledPluginFixture({
      id: 'pomodoro-timer',
      name: 'Focus Timer',
      source: 'export default function fixedVersion() { return "fixed"; }',
      readme: 'FIXED README',
    });

    const partialPluginDir = path.join(cosPath, 'plugins', 'pomodoro-timer');
    await fs.mkdir(partialPluginDir, { recursive: true });
    await fs.writeFile(
      path.join(partialPluginDir, 'manifest.json'),
      JSON.stringify({ id: 'pomodoro-timer', name: 'Partial', entryPoint: 'index.tsx' }, null, 2),
      'utf-8',
    );
    // Intentionally no index.tsx

    const result = await seedBundledPluginsToSpace({ alreadySeededIds: [] });

    expect(result).toEqual({
      seeded: ['pomodoro-timer'],
      skipped: [],
      failed: [],
      malformed: [],
    });
    await expect(
      fs.readFile(path.join(partialPluginDir, 'index.tsx'), 'utf-8'),
    ).resolves.toBe('export default function fixedVersion() { return "fixed"; }');
    await expect(
      fs.readFile(path.join(partialPluginDir, 'manifest.json'), 'utf-8'),
    ).resolves.toContain('"name": "Focus Timer"');
  });

  it('reports malformed bundled manifests and continues seeding valid plugins', async () => {
    await writeBundledPluginFixture({ id: 'pomodoro-timer', name: 'Focus Timer' });
    await writeBundledPluginFixture({ id: 'research-hub', name: 'Research Hub' });
    await writeBundledPluginFixture({
      id: 'broken-plugin',
      manifestOverride: {
        id: 'broken-plugin',
        entryPoint: 'index.tsx',
      },
    });

    const result = await seedBundledPluginsToSpace({ alreadySeededIds: [] });

    expect(result.seeded.slice().sort()).toEqual(['pomodoro-timer', 'research-hub']);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.malformed).toEqual(['broken-plugin']);
  });

  it('reports bundled entries missing index.tsx as malformed so renderer can surface a notice', async () => {
    await writeBundledPluginFixture({ id: 'pomodoro-timer', name: 'Focus Timer' });
    await writeBundledPluginFixture({ id: 'research-hub', name: 'Research Hub' });
    await writeBundledPluginFixture({
      id: 'missing-source',
      name: 'Missing Source',
      writeIndex: false,
    });

    const result = await seedBundledPluginsToSpace({ alreadySeededIds: [] });

    expect(result.seeded.slice().sort()).toEqual(['pomodoro-timer', 'research-hub']);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.malformed).toEqual(['missing-source']);
    await expect(listSeededPluginDirs()).resolves.toEqual(['pomodoro-timer', 'research-hub']);
  });

  it('returns empty results when bundled plugins root is missing', async () => {
    mockGetSystemSettingsPath.mockReturnValue(path.join(tempDir, 'missing-system-settings'));

    const result = await seedBundledPluginsToSpace({ alreadySeededIds: [] });

    expect(result).toEqual({
      seeded: [],
      skipped: [],
      failed: [],
      malformed: [],
    });
  });

  it('preserves bundled README content during seed', async () => {
    await writeBundledPluginFixture({
      id: 'pomodoro-timer',
      name: 'Focus Timer',
      readme: 'TEST_CONTENT',
    });

    const result = await seedBundledPluginsToSpace({ alreadySeededIds: [] });

    expect(result).toEqual({
      seeded: ['pomodoro-timer'],
      skipped: [],
      failed: [],
      malformed: [],
    });
    await expect(
      fs.readFile(path.join(cosPath, 'plugins', 'pomodoro-timer', 'README.md'), 'utf-8'),
    ).resolves.toBe('TEST_CONTENT');
  });
});
