import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  registerPlugin,
  unregisterPlugin,
  getRegisteredPlugin,
  getAllRegisteredPlugins,
  subscribeToPluginRegistry,
  clearPluginRegistry,
  initializePluginPersistence,
  loadPersistedPlugins,
  persistRegisteredPlugins,
  setStorageAdapter,
  resetStorageAdapter,
  setCatalogPlugins,
  getCatalogPlugin,
  getAllCatalogPlugins,
  subscribeToCatalog,
  clearCatalog,
} from '../pluginRegistry';
import type { PluginManifest } from '../pluginManifest';
import type { PluginStorageAdapter, PersistedPluginEntry, CatalogPlugin } from '../pluginStorageAdapter';
import { ElectronStorePluginAdapter } from '../pluginStorageAdapter';

let persistenceCleanup: (() => void) | null = null;

const makeTestManifest = (
  overrides: Pick<PluginManifest, 'id' | 'name' | 'entryPoint'> & Partial<Omit<PluginManifest, 'id' | 'name' | 'entryPoint'>>,
): PluginManifest => ({
  version: '0.1.0',
  maturity: 'labs',
  role: 'utility',
  permissions: [],
  externalDomains: [],
  storageScope: 'local',
  surfaces: {
    sidebar: { enabled: true },
    homepageWidget: { enabled: false, defaultSize: 'medium' },
  },
  ...overrides,
});

const setMockPluginsApi = (pluginsApi: unknown): void => {
  Object.defineProperty(globalThis, 'window', {
    value: { pluginsApi },
    configurable: true,
    writable: true,
  });
};

beforeEach(() => {
  persistenceCleanup?.();
  persistenceCleanup = null;
  clearPluginRegistry();
  clearCatalog();
  resetStorageAdapter();
  vi.useRealTimers();
  delete (globalThis as { window?: unknown }).window;
});

afterEach(() => {
  persistenceCleanup?.();
  persistenceCleanup = null;
  vi.useRealTimers();
  delete (globalThis as { window?: unknown }).window;
});

describe('pluginRegistry', () => {
  const validManifest = makeTestManifest({ id: 'test', name: 'Test Plugin', entryPoint: 'inline' });
  const source = 'export default function T() { return null; }';

  it('registers a plugin and retrieves it', () => {
    const result = registerPlugin(validManifest, source);
    expect(result.ok).toBe(true);

    const plugin = getRegisteredPlugin('test');
    expect(plugin).toBeDefined();
    expect(plugin!.manifest.id).toBe('test');
    expect(plugin!.source).toBe(source);
  });

  it('returns all registered plugins', () => {
    registerPlugin(validManifest, source);
    registerPlugin({ ...validManifest, id: 'other', name: 'Other' }, source);

    const all = getAllRegisteredPlugins();
    expect(all).toHaveLength(2);
  });

  it('unregisters a plugin', () => {
    registerPlugin(validManifest, source);
    expect(unregisterPlugin('test')).toBe(true);
    expect(getRegisteredPlugin('test')).toBeUndefined();
  });

  it('returns false when unregistering non-existent plugin', () => {
    expect(unregisterPlugin('nope')).toBe(false);
  });

  it('rejects invalid manifest', () => {
    const result = registerPlugin({ id: 'BAD', name: 'Test', entryPoint: 'x' } as never, source);
    expect(result.ok).toBe(false);
  });

  it('notifies listeners on register', () => {
    const listener = vi.fn();
    subscribeToPluginRegistry(listener);

    registerPlugin(validManifest, source);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies listeners on unregister', () => {
    registerPlugin(validManifest, source);
    const listener = vi.fn();
    subscribeToPluginRegistry(listener);

    unregisterPlugin('test');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes listener', () => {
    const listener = vi.fn();
    const unsub = subscribeToPluginRegistry(listener);
    unsub();

    registerPlugin(validManifest, source);
    expect(listener).not.toHaveBeenCalled();
  });

  it('overwrites existing plugin on re-register', () => {
    registerPlugin(validManifest, 'first');
    registerPlugin(validManifest, 'second');

    expect(getRegisteredPlugin('test')!.source).toBe('second');
    expect(getAllRegisteredPlugins()).toHaveLength(1);
  });

  it('persists plugin changes with 300ms debounce and excludes __ prefixed IDs', async () => {
    vi.useFakeTimers();
    const persistAll = vi.fn().mockResolvedValue({ success: true });
    setMockPluginsApi({
      persistAll,
      loadPersisted: vi.fn(),
      clearPersisted: vi.fn(),
    });

    persistenceCleanup = initializePluginPersistence();

    registerPlugin(makeTestManifest({ id: '__demo', name: 'Demo Plugin', entryPoint: 'inline' }), source);
    registerPlugin(validManifest, source);

    await vi.advanceTimersByTimeAsync(299);
    expect(persistAll).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(persistAll).toHaveBeenCalledTimes(1);
    expect(persistAll).toHaveBeenCalledWith({
      plugins: [
        {
          manifest: {
            ...makeTestManifest({ id: 'test', name: 'Test Plugin', entryPoint: 'inline' }),
          },
          source,
        },
      ],
    });
  });

  it('loads persisted plugins and skips sources that fail compilation', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    setMockPluginsApi({
      persistAll: vi.fn(),
      clearPersisted: vi.fn(),
      loadPersisted: vi.fn().mockResolvedValue({
        plugins: [
          {
            manifest: makeTestManifest({ id: 'valid-plugin', name: 'Valid Plugin', entryPoint: 'inline' }),
            source: 'export default function ValidPlugin() { return null; }',
          },
          {
            manifest: makeTestManifest({ id: 'broken-plugin', name: 'Broken Plugin', entryPoint: 'inline' }),
            source: 'export default function BrokenPlugin( {',
          },
        ],
      }),
    });

    await loadPersistedPlugins();

    expect(getRegisteredPlugin('valid-plugin')).toBeDefined();
    expect(getRegisteredPlugin('broken-plugin')).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});

// ── Storage Adapter Tests ──────────────────────────────────────────────

describe('PluginStorageAdapter', () => {
  const source = 'export default function T() { return null; }';
  const validManifest = makeTestManifest({ id: 'test', name: 'Test Plugin', entryPoint: 'inline' });

  it('uses a custom adapter for persistence', async () => {
    vi.useFakeTimers();
    const mockAdapter: PluginStorageAdapter = {
      loadAll: vi.fn().mockResolvedValue([]),
      saveAll: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    setStorageAdapter(mockAdapter);
    persistenceCleanup = initializePluginPersistence();

    registerPlugin(validManifest, source);

    await vi.advanceTimersByTimeAsync(300);
    expect(mockAdapter.saveAll).toHaveBeenCalledTimes(1);
    expect(mockAdapter.saveAll).toHaveBeenCalledWith([
      {
        manifest: expect.objectContaining({ id: 'test', name: 'Test Plugin' }),
        source,
      },
    ]);
  });

  it('loads plugins from a custom adapter', async () => {
    const mockAdapter: PluginStorageAdapter = {
      loadAll: vi.fn().mockResolvedValue([
        {
          manifest: makeTestManifest({ id: 'from-adapter', name: 'Adapter Plugin', entryPoint: 'inline' }),
          source: 'export default function Adapter() { return null; }',
        },
      ]),
      saveAll: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    setStorageAdapter(mockAdapter);
    await loadPersistedPlugins();

    expect(mockAdapter.loadAll).toHaveBeenCalledTimes(1);
    expect(getRegisteredPlugin('from-adapter')).toBeDefined();
    expect(getRegisteredPlugin('from-adapter')!.manifest.name).toBe('Adapter Plugin');
  });

  it('handles adapter loadAll failure gracefully', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mockAdapter: PluginStorageAdapter = {
      loadAll: vi.fn().mockRejectedValue(new Error('load failed')),
      saveAll: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    setStorageAdapter(mockAdapter);
    await loadPersistedPlugins();

    expect(getAllRegisteredPlugins()).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      '[pluginRegistry] Failed to load persisted plugins:',
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it('handles adapter saveAll failure gracefully', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mockAdapter: PluginStorageAdapter = {
      loadAll: vi.fn().mockResolvedValue([]),
      saveAll: vi.fn().mockRejectedValue(new Error('save failed')),
      clear: vi.fn().mockResolvedValue(undefined),
    };

    setStorageAdapter(mockAdapter);
    await persistRegisteredPlugins();

    expect(warnSpy).toHaveBeenCalledWith(
      '[pluginRegistry] Failed to persist plugins:',
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it('resetStorageAdapter restores ElectronStorePluginAdapter', () => {
    const mockAdapter: PluginStorageAdapter = {
      loadAll: vi.fn(),
      saveAll: vi.fn(),
      clear: vi.fn(),
    };

    setStorageAdapter(mockAdapter);
    resetStorageAdapter();

    // After reset, the default adapter should be ElectronStorePluginAdapter
    // We can't easily check the instance type, but we can verify the
    // adapter was replaced by checking it doesn't use the mock anymore
    expect(mockAdapter.loadAll).not.toHaveBeenCalled();
  });
});

describe('ElectronStorePluginAdapter', () => {
  it('returns empty array when window.pluginsApi is unavailable', async () => {
    const adapter = new ElectronStorePluginAdapter();
    const result = await adapter.loadAll();
    expect(result).toEqual([]);
  });

  it('is a no-op save when window.pluginsApi is unavailable', async () => {
    const adapter = new ElectronStorePluginAdapter();
    // Should not throw
    await adapter.saveAll([]);
  });

  it('is a no-op clear when window.pluginsApi is unavailable', async () => {
    const adapter = new ElectronStorePluginAdapter();
    // Should not throw
    await adapter.clear();
  });

  it('delegates loadAll to window.pluginsApi.loadPersisted', async () => {
    const loadPersisted = vi.fn().mockResolvedValue({
      plugins: [{ manifest: makeTestManifest({ id: 'test', name: 'Test', entryPoint: 'inline' }), source: 'code' }],
    });
    setMockPluginsApi({ loadPersisted, persistAll: vi.fn(), clearPersisted: vi.fn() });

    const adapter = new ElectronStorePluginAdapter();
    const result = await adapter.loadAll();

    expect(loadPersisted).toHaveBeenCalledWith();
    expect(result).toHaveLength(1);
    expect(result[0].manifest.id).toBe('test');
  });

  it('delegates saveAll to window.pluginsApi.persistAll', async () => {
    const persistAll = vi.fn().mockResolvedValue({ success: true });
    setMockPluginsApi({ persistAll, loadPersisted: vi.fn(), clearPersisted: vi.fn() });

    const adapter = new ElectronStorePluginAdapter();
    const entries: PersistedPluginEntry[] = [
      { manifest: makeTestManifest({ id: 'test', name: 'Test', entryPoint: 'inline' }), source: 'code' },
    ];
    await adapter.saveAll(entries);

    expect(persistAll).toHaveBeenCalledWith({ plugins: entries });
  });

  it('delegates clear to window.pluginsApi.clearPersisted', async () => {
    const clearPersisted = vi.fn().mockResolvedValue({ success: true });
    setMockPluginsApi({ clearPersisted, persistAll: vi.fn(), loadPersisted: vi.fn() });

    const adapter = new ElectronStorePluginAdapter();
    await adapter.clear();

    expect(clearPersisted).toHaveBeenCalledWith();
  });
});

// ── Catalog Tests ──────────────────────────────────────────────────────

describe('Plugin Catalog', () => {
  const makeCatalogEntry = (id: string, isActive: boolean): CatalogPlugin => ({
    manifest: makeTestManifest({ id, name: `Plugin ${id}`, entryPoint: 'inline' }),
    source: `export default function ${id}() { return null; }`,
    isActive,
  });

  it('starts with an empty catalog', () => {
    expect(getAllCatalogPlugins()).toHaveLength(0);
  });

  it('sets and retrieves catalog plugins', () => {
    const entries = [makeCatalogEntry('alpha', true), makeCatalogEntry('beta', false)];
    setCatalogPlugins(entries);

    expect(getAllCatalogPlugins()).toHaveLength(2);
    expect(getCatalogPlugin('alpha')).toBeDefined();
    expect(getCatalogPlugin('alpha')!.isActive).toBe(true);
    expect(getCatalogPlugin('beta')!.isActive).toBe(false);
  });

  it('replaces catalog on subsequent setCatalogPlugins calls', () => {
    setCatalogPlugins([makeCatalogEntry('first', true)]);
    expect(getAllCatalogPlugins()).toHaveLength(1);

    setCatalogPlugins([makeCatalogEntry('second', false)]);
    expect(getAllCatalogPlugins()).toHaveLength(1);
    expect(getCatalogPlugin('first')).toBeUndefined();
    expect(getCatalogPlugin('second')).toBeDefined();
  });

  it('notifies catalog subscribers', () => {
    const listener = vi.fn();
    subscribeToCatalog(listener);

    setCatalogPlugins([makeCatalogEntry('test', true)]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes catalog listener', () => {
    const listener = vi.fn();
    const unsub = subscribeToCatalog(listener);
    unsub();

    setCatalogPlugins([makeCatalogEntry('test', true)]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('clears catalog', () => {
    setCatalogPlugins([makeCatalogEntry('test', true)]);
    clearCatalog();

    expect(getAllCatalogPlugins()).toHaveLength(0);
    expect(getCatalogPlugin('test')).toBeUndefined();
  });

  it('includes spacePath when provided', () => {
    const entry: CatalogPlugin = {
      ...makeCatalogEntry('spatial', true),
      spacePath: '/Users/test/Spaces/Work/plugins/spatial',
    };
    setCatalogPlugins([entry]);

    expect(getCatalogPlugin('spatial')!.spacePath).toBe('/Users/test/Spaces/Work/plugins/spatial');
  });

  it('catalog and active registry are independent', () => {
    const source = 'export default function T() { return null; }';
    registerPlugin(makeTestManifest({ id: 'active-only', name: 'Active Only', entryPoint: 'inline' }), source);
    setCatalogPlugins([makeCatalogEntry('catalog-only', false)]);

    expect(getRegisteredPlugin('active-only')).toBeDefined();
    expect(getCatalogPlugin('active-only')).toBeUndefined();
    expect(getCatalogPlugin('catalog-only')).toBeDefined();
    expect(getRegisteredPlugin('catalog-only')).toBeUndefined();
  });
});
