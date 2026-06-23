// @vitest-environment happy-dom
/**
 * Tests for usePluginsLensData — verifies the merged Plugin lens dataset.
 *
 * Critical invariant: PluginCard's `isActive` MUST live-update the moment a
 * user toggles the plugin on/off, even when the catalog flag (from the last
 * Space scan) lags behind. We achieve this by deriving `isActive` from the
 * live plugin registry IDs rather than the cached catalog.isActive snapshot.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '../../../../test-utils/hookTestHarness';
import type { CatalogPlugin, RegisteredPlugin } from '../../manifest/pluginRegistry';
import type { PluginManifest } from '../../manifest/pluginManifest';

const mockUseSpacePlugins = vi.fn();
const mockUseRegisteredPlugins = vi.fn();
const mockUseSettingsSafe = vi.fn();

vi.mock('../useSpacePlugins', () => ({
  useSpacePlugins: () => mockUseSpacePlugins(),
}));

vi.mock('../useRegisteredPlugins', () => ({
  useRegisteredPlugins: () => mockUseRegisteredPlugins(),
}));

vi.mock('@renderer/features/settings', () => ({
  useSettingsSafe: () => mockUseSettingsSafe(),
}));

import { usePluginsLensData } from '../usePluginsLensData';

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'pomodoro-timer',
    name: 'Pomodoro Timer',
    entryPoint: 'index.tsx',
    version: '0.1.0',
    maturity: 'labs',
    role: 'utility',
    permissions: [],
    externalDomains: [],
    surfaces: { sidebar: { enabled: true }, homepageWidget: { enabled: false, defaultSize: 'medium' } },
    ...overrides,
  };
}

function makeCatalogEntry(overrides: Partial<CatalogPlugin> = {}): CatalogPlugin {
  return {
    manifest: makeManifest(),
    source: 'export default function Plugin() { return null; }',
    spacePath: '/Users/me/Spaces/Acme/Operations',
    isActive: false,
    ...overrides,
  };
}

function makeRegistered(manifest: PluginManifest): RegisteredPlugin {
  return {
    manifest,
    source: 'export default function Plugin() { return null; }',
    registeredAt: Date.now(),
  };
}

describe('usePluginsLensData', () => {
  beforeEach(() => {
    mockUseSpacePlugins.mockReset();
    mockUseRegisteredPlugins.mockReset();
    mockUseSettingsSafe.mockReset();
    mockUseSettingsSafe.mockReturnValue({ settings: { seededBundledPluginIds: [] } });
  });

  it('derives isActive from the live registry, not the catalog snapshot', () => {
    const manifest = makeManifest({ id: 'pomodoro-timer', name: 'Pomodoro Timer' });
    mockUseSpacePlugins.mockReturnValue({
      spacePlugins: [makeCatalogEntry({ manifest, isActive: false })],
      conflicts: [],
      isLoading: false,
      error: null,
      refresh: () => {},
    });
    mockUseRegisteredPlugins.mockReturnValue([makeRegistered(manifest)]);

    const { result } = renderHook(() => usePluginsLensData());
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].isActive).toBe(true);
  });

  it('marks Space-origin entries inactive when the registry is empty', () => {
    const manifest = makeManifest({ id: 'pomodoro-timer' });
    mockUseSpacePlugins.mockReturnValue({
      spacePlugins: [makeCatalogEntry({ manifest, isActive: true })],
      conflicts: [],
      isLoading: false,
      error: null,
      refresh: () => {},
    });
    mockUseRegisteredPlugins.mockReturnValue([]);

    const { result } = renderHook(() => usePluginsLensData());
    expect(result.current.entries[0].isActive).toBe(false);
  });

  it('emits a local-origin entry for plugins only in the registry', () => {
    const manifest = makeManifest({ id: 'local-only', name: 'Local Only' });
    mockUseSpacePlugins.mockReturnValue({
      spacePlugins: [],
      conflicts: [],
      isLoading: false,
      error: null,
      refresh: () => {},
    });
    mockUseRegisteredPlugins.mockReturnValue([makeRegistered(manifest)]);

    const { result } = renderHook(() => usePluginsLensData());
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]).toMatchObject({
      pluginId: 'local-only',
      origin: 'local',
      isActive: true,
    });
  });

  it('prefers Space-origin over local-only when the same id appears in both', () => {
    const manifest = makeManifest({ id: 'pomodoro-timer' });
    mockUseSpacePlugins.mockReturnValue({
      spacePlugins: [makeCatalogEntry({ manifest, spacePath: '/Spaces/Acme', isActive: false })],
      conflicts: [],
      isLoading: false,
      error: null,
      refresh: () => {},
    });
    mockUseRegisteredPlugins.mockReturnValue([makeRegistered(manifest)]);

    const { result } = renderHook(() => usePluginsLensData());
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]).toMatchObject({
      origin: 'space',
      spacePath: '/Spaces/Acme',
      isActive: true,
    });
  });

  it('attaches conflict files when reported by useSpacePlugins', () => {
    const manifest = makeManifest({ id: 'pomodoro-timer' });
    mockUseSpacePlugins.mockReturnValue({
      spacePlugins: [makeCatalogEntry({ manifest })],
      conflicts: [{ pluginId: 'pomodoro-timer', conflictFiles: ['plugin.tsx'] }],
      isLoading: false,
      error: null,
      refresh: () => {},
    });
    mockUseRegisteredPlugins.mockReturnValue([]);

    const { result } = renderHook(() => usePluginsLensData());
    expect(result.current.entries[0].conflictFiles).toEqual(['plugin.tsx']);
  });

  it('derives isBuiltIn from seededBundledPluginIds for space plugins', () => {
    const manifest = makeManifest({ id: 'pomodoro-timer', name: 'Focus Timer' });
    mockUseSettingsSafe.mockReturnValue({ settings: { seededBundledPluginIds: ['pomodoro-timer'] } });
    mockUseSpacePlugins.mockReturnValue({
      spacePlugins: [makeCatalogEntry({ manifest })],
      conflicts: [],
      isLoading: false,
      error: null,
      refresh: () => {},
    });
    mockUseRegisteredPlugins.mockReturnValue([]);

    const { result } = renderHook(() => usePluginsLensData());
    expect(result.current.entries[0]).toMatchObject({
      pluginId: 'pomodoro-timer',
      origin: 'space',
      isBuiltIn: true,
    });
  });

  it('marks isBuiltIn false for unseeded space plugins and all local plugins', () => {
    const seededSpaceManifest = makeManifest({ id: 'pomodoro-timer', name: 'Focus Timer' });
    const unseededSpaceManifest = makeManifest({ id: 'research-hub', name: 'Research Hub' });
    const localManifest = makeManifest({ id: 'sources-browser', name: 'My Sources' });
    mockUseSettingsSafe.mockReturnValue({ settings: { seededBundledPluginIds: ['pomodoro-timer', 'sources-browser'] } });
    mockUseSpacePlugins.mockReturnValue({
      spacePlugins: [
        makeCatalogEntry({ manifest: seededSpaceManifest }),
        makeCatalogEntry({ manifest: unseededSpaceManifest }),
      ],
      conflicts: [],
      isLoading: false,
      error: null,
      refresh: () => {},
    });
    mockUseRegisteredPlugins.mockReturnValue([makeRegistered(localManifest)]);

    const { result } = renderHook(() => usePluginsLensData());
    const byId = new Map(result.current.entries.map((entry) => [entry.pluginId, entry]));
    expect(byId.get('research-hub')?.isBuiltIn).toBe(false);
    expect(byId.get('sources-browser')?.origin).toBe('local');
    expect(byId.get('sources-browser')?.isBuiltIn).toBe(false);
  });
});
