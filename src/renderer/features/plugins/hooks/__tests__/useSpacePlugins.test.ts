import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mockGetAllRegisteredPlugins = vi.fn();
const mockRegisterPlugin = vi.fn();
const mockUnregisterPlugin = vi.fn();
const mockGetAllCatalogPlugins = vi.fn();
const mockSetCatalogPlugins = vi.fn();

vi.mock('../../manifest/pluginRegistry', () => ({
  getAllRegisteredPlugins: (...args: unknown[]) => mockGetAllRegisteredPlugins(...args),
  registerPlugin: (...args: unknown[]) => mockRegisterPlugin(...args),
  unregisterPlugin: (...args: unknown[]) => mockUnregisterPlugin(...args),
  getAllCatalogPlugins: (...args: unknown[]) => mockGetAllCatalogPlugins(...args),
  setCatalogPlugins: (...args: unknown[]) => mockSetCatalogPlugins(...args),
}));

import { createDefaultSpacePluginsController, isChiefOfStaffSpace, syncSpacePluginsCatalog } from '../useSpacePlugins';
import type { SpacePluginsControllerDeps } from '../useSpacePlugins';

type MockPluginsApi = {
  scanSpaces: ReturnType<typeof vi.fn>;
  onSpacePluginsChanged: ReturnType<typeof vi.fn>;
  getActivated: ReturnType<typeof vi.fn>;
  indexReadme?: ReturnType<typeof vi.fn>;
  deindexReadme?: ReturnType<typeof vi.fn>;
};

function createPluginInfo(pluginId: string, name: string, spacePath = '/Users/test/Spaces/Work/AcmeConsulting') {
  return {
    pluginId,
    manifest: {
      id: pluginId,
      name,
      entryPoint: 'inline',
      version: '0.1.0',
      maturity: 'labs',
    },
    source: 'export default function Plugin() { return null; }',
    spaceName: 'AcmeConsulting',
    spacePath,
  };
}

describe('useSpacePlugins controller', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    mockGetAllRegisteredPlugins.mockReset();
    mockRegisterPlugin.mockReset();
    mockUnregisterPlugin.mockReset();
    mockGetAllCatalogPlugins.mockReset();
    mockSetCatalogPlugins.mockReset();

    mockGetAllRegisteredPlugins.mockReturnValue([]);
    mockRegisterPlugin.mockReturnValue({ ok: true });
    mockUnregisterPlugin.mockReturnValue(true);
    mockGetAllCatalogPlugins.mockReturnValue([]);
  });

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  it('scans on start and populates catalog', async () => {
    const scanSpaces = vi.fn().mockResolvedValue({
      plugins: [createPluginInfo('meeting-prep', 'Meeting Prep')],
      conflicts: [],
    });
    let watcherCallback: (() => void) | null = null;
    const onSpacePluginsChanged = vi.fn((callback: () => void) => {
      watcherCallback = callback;
      return () => {
        watcherCallback = null;
      };
    });
    const getActivated = vi.fn().mockResolvedValue({ pluginIds: [] });

    globalThis.window = {
      pluginsApi: { scanSpaces, onSpacePluginsChanged, getActivated } as MockPluginsApi,
    } as unknown as Window & typeof globalThis;

    const controller = createDefaultSpacePluginsController();
    controller.start();

    await vi.waitFor(() => {
      expect(scanSpaces).toHaveBeenCalledTimes(1);
      expect(mockSetCatalogPlugins).toHaveBeenCalledTimes(1);
      expect(controller.getState().isLoading).toBe(false);
    });

    expect(onSpacePluginsChanged).toHaveBeenCalledTimes(1);
    expect(watcherCallback).not.toBeNull();
    expect(controller.getState().error).toBeNull();
    expect(controller.getState().spacePlugins).toHaveLength(1);
    expect(controller.getState().spacePlugins[0].manifest.id).toBe('meeting-prep');
    expect(controller.getState().spacePlugins[0].isActive).toBe(false);
    expect(controller.getState().conflicts).toEqual([]);
  });

  it('stores detected plugin conflicts from scan results', async () => {
    const scanSpaces = vi.fn().mockResolvedValue({
      plugins: [createPluginInfo('meeting-prep', 'Meeting Prep')],
      conflicts: [
        {
          pluginId: 'meeting-prep',
          conflictFiles: ['manifest (1).json'],
          spacePath: '/Users/test/Spaces/Work/AcmeConsulting',
        },
      ],
    });

    globalThis.window = {
      pluginsApi: {
        scanSpaces,
        onSpacePluginsChanged: vi.fn(() => undefined),
        getActivated: vi.fn().mockResolvedValue({ pluginIds: [] }),
      } as MockPluginsApi,
    } as unknown as Window & typeof globalThis;

    const controller = createDefaultSpacePluginsController();
    controller.start();

    await vi.waitFor(() => {
      expect(controller.getState().conflicts).toEqual([
        {
          pluginId: 'meeting-prep',
          conflictFiles: ['manifest (1).json'],
          spacePath: '/Users/test/Spaces/Work/AcmeConsulting',
        },
      ]);
    });
  });

  it('re-scans when plugins:space-changed callback fires', async () => {
    const scanSpaces = vi
      .fn()
      .mockResolvedValueOnce({ plugins: [createPluginInfo('meeting-prep', 'Meeting Prep')], conflicts: [] })
      .mockResolvedValueOnce({ plugins: [createPluginInfo('inbox-triage', 'Inbox Triage')], conflicts: [] });

    let watcherCallback: (() => void) | null = null;
    const onSpacePluginsChanged = vi.fn((callback: () => void) => {
      watcherCallback = callback;
      return () => {
        watcherCallback = null;
      };
    });

    globalThis.window = {
      pluginsApi: {
        scanSpaces,
        onSpacePluginsChanged,
        getActivated: vi.fn().mockResolvedValue({ pluginIds: [] }),
      } as MockPluginsApi,
    } as unknown as Window & typeof globalThis;

    const controller = createDefaultSpacePluginsController();
    controller.start();

    await vi.waitFor(() => {
      expect(scanSpaces).toHaveBeenCalledTimes(1);
      expect(controller.getState().spacePlugins[0].manifest.id).toBe('meeting-prep');
    });

    const callback = watcherCallback as (() => void) | null;
    if (callback) {
      callback();
    }

    await vi.waitFor(() => {
      expect(scanSpaces).toHaveBeenCalledTimes(2);
      expect(controller.getState().spacePlugins[0].manifest.id).toBe('inbox-triage');
    });
  });

  it('auto-registers activated Space plugins during scan', async () => {
    const scanSpaces = vi.fn().mockResolvedValue({
      plugins: [createPluginInfo('meeting-prep', 'Meeting Prep')],
      conflicts: [],
    });
    const indexReadme = vi.fn().mockResolvedValue({ success: true });

    globalThis.window = {
      pluginsApi: {
        scanSpaces,
        onSpacePluginsChanged: vi.fn(() => undefined),
        getActivated: vi.fn().mockResolvedValue({ pluginIds: ['meeting-prep'] }),
        indexReadme,
      } as MockPluginsApi,
    } as unknown as Window & typeof globalThis;

    const controller = createDefaultSpacePluginsController();
    controller.start();

    await vi.waitFor(() => {
      expect(mockRegisterPlugin).toHaveBeenCalledTimes(1);
      expect(mockRegisterPlugin).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'meeting-prep' }),
        expect.any(String),
      );
      expect(indexReadme).toHaveBeenCalledWith({
        pluginId: 'meeting-prep',
        spacePath: '/Users/test/Spaces/Work/AcmeConsulting',
      });
      expect(controller.getState().spacePlugins[0].isActive).toBe(true);
    }, { timeout: 4000 });
  });

  it('tracks loading and error state when scan fails', async () => {
    const scanSpaces = vi.fn().mockRejectedValue(new Error('Scan failed'));

    globalThis.window = {
      pluginsApi: {
        scanSpaces,
        onSpacePluginsChanged: vi.fn(() => undefined),
        getActivated: vi.fn().mockResolvedValue({ pluginIds: [] }),
      } as MockPluginsApi,
    } as unknown as Window & typeof globalThis;

    const controller = createDefaultSpacePluginsController();
    const stateHistory: Array<{ isLoading: boolean; error: string | null }> = [];
    controller.subscribe(() => {
      const { isLoading, error } = controller.getState();
      stateHistory.push({ isLoading, error });
    });

    controller.start();

    await vi.waitFor(() => {
      expect(controller.getState().isLoading).toBe(false);
      expect(controller.getState().error).toBe('Scan failed');
    });

    expect(stateHistory.some((state) => state.isLoading)).toBe(true);
    expect(mockSetCatalogPlugins).not.toHaveBeenCalled();
  });
});

describe('isChiefOfStaffSpace', () => {
  it('returns true for "Chief-of-Staff"', () => {
    expect(isChiefOfStaffSpace('Chief-of-Staff')).toBe(true);
  });

  it('returns true for case-insensitive match', () => {
    expect(isChiefOfStaffSpace('chief-of-staff')).toBe(true);
    expect(isChiefOfStaffSpace('CHIEF-OF-STAFF')).toBe(true);
  });

  it('returns false for other space names', () => {
    expect(isChiefOfStaffSpace('AcmeConsulting')).toBe(false);
    expect(isChiefOfStaffSpace('Personal')).toBe(false);
    expect(isChiefOfStaffSpace('Chief')).toBe(false);
  });
});

describe('Chief-of-Staff auto-activation', () => {
  function createMockDeps(overrides: Partial<SpacePluginsControllerDeps> = {}): SpacePluginsControllerDeps {
    return {
      scanSpaces: vi.fn().mockResolvedValue({ plugins: [], conflicts: [] }),
      onSpacePluginsChanged: vi.fn(() => () => {}),
      getActivatedPluginIds: vi.fn().mockResolvedValue([]),
      getDeactivatedPluginIds: vi.fn().mockResolvedValue([]),
      getPendingReviewPluginIds: vi.fn().mockResolvedValue([]),
      indexReadme: vi.fn().mockResolvedValue(undefined),
      deindexReadme: vi.fn().mockResolvedValue(undefined),
      getRegisteredPlugins: vi.fn().mockReturnValue([]),
      registerPlugin: vi.fn().mockReturnValue({ ok: true }),
      unregisterPlugin: vi.fn().mockReturnValue(true),
      getCatalogPlugins: vi.fn().mockReturnValue([]),
      setCatalogPlugins: vi.fn(),
      compileSource: vi.fn().mockResolvedValue(true),
      ...overrides,
    };
  }

  it('auto-registers Chief-of-Staff plugins without activation store entry', async () => {
    const chiefPlugin = {
      pluginId: 'my-plugin',
      manifest: { id: 'my-plugin', name: 'My Plugin', entryPoint: 'index.tsx', version: '0.1.0', maturity: 'labs' },
      source: 'export default function() { return null; }',
      spaceName: 'Chief-of-Staff',
      spacePath: '/Users/test/workspace/Chief-of-Staff',
    };

    const deps = createMockDeps({
      scanSpaces: vi.fn().mockResolvedValue({ plugins: [chiefPlugin], conflicts: [] }),
      getActivatedPluginIds: vi.fn().mockResolvedValue([]), // NOT in activation store
    });

    await syncSpacePluginsCatalog(deps);

    expect(deps.registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'my-plugin' }),
      expect.any(String),
    );
  });

  it('does NOT auto-register team Space plugins without activation', async () => {
    const teamPlugin = {
      pluginId: 'team-plugin',
      manifest: { id: 'team-plugin', name: 'Team Plugin', entryPoint: 'index.tsx', version: '0.1.0', maturity: 'labs' },
      source: 'export default function() { return null; }',
      spaceName: 'AcmeConsulting',
      spacePath: '/Users/test/workspace/Work/AcmeConsulting',
    };

    const deps = createMockDeps({
      scanSpaces: vi.fn().mockResolvedValue({ plugins: [teamPlugin], conflicts: [] }),
      getActivatedPluginIds: vi.fn().mockResolvedValue([]), // NOT in activation store
    });

    await syncSpacePluginsCatalog(deps);

    expect(deps.registerPlugin).not.toHaveBeenCalled();
  });

  it('registers team Space plugins that are explicitly activated', async () => {
    const teamPlugin = {
      pluginId: 'team-plugin',
      manifest: { id: 'team-plugin', name: 'Team Plugin', entryPoint: 'index.tsx', version: '0.1.0', maturity: 'labs' },
      source: 'export default function() { return null; }',
      spaceName: 'AcmeConsulting',
      spacePath: '/Users/test/workspace/Work/AcmeConsulting',
    };

    const deps = createMockDeps({
      scanSpaces: vi.fn().mockResolvedValue({ plugins: [teamPlugin], conflicts: [] }),
      getActivatedPluginIds: vi.fn().mockResolvedValue(['team-plugin']),
    });

    await syncSpacePluginsCatalog(deps);

    expect(deps.registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'team-plugin' }),
      expect.any(String),
    );
  });

  it('flags a pending-review plugin in the catalog (isPendingReview) without registering it (Stage 3A)', async () => {
    const pendingPlugin = {
      pluginId: 'community-dashboard',
      manifest: { id: 'community-dashboard', name: 'Community Dashboard', entryPoint: 'index.tsx', version: '0.1.0', maturity: 'labs' },
      source: 'export default function() { return null; }',
      spaceName: 'Chief-of-Staff',
      spacePath: '/Users/test/workspace/Chief-of-Staff',
    };

    const deps = createMockDeps({
      scanSpaces: vi.fn().mockResolvedValue({ plugins: [pendingPlugin], conflicts: [] }),
      // Held inactive via deactivated (suppresses CoS auto-activation) and flagged pending-review.
      getDeactivatedPluginIds: vi.fn().mockResolvedValue(['community-dashboard']),
      getPendingReviewPluginIds: vi.fn().mockResolvedValue(['community-dashboard']),
    });

    await syncSpacePluginsCatalog(deps);

    // Not registered live (held for review).
    expect(deps.registerPlugin).not.toHaveBeenCalled();
    // Catalog entry carries the pending-review flag for the UI affordance.
    expect(deps.setCatalogPlugins).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          manifest: expect.objectContaining({ id: 'community-dashboard' }),
          isActive: false,
          isPendingReview: true,
        }),
      ]),
    );
  });

  it('does NOT auto-register CoS plugin that was explicitly deactivated', async () => {
    const chiefPlugin = {
      pluginId: 'my-plugin',
      manifest: { id: 'my-plugin', name: 'My Plugin', entryPoint: 'index.tsx', version: '0.1.0', maturity: 'labs' },
      source: 'export default function() { return null; }',
      spaceName: 'Chief-of-Staff',
      spacePath: '/Users/test/workspace/Chief-of-Staff',
    };

    const deps = createMockDeps({
      scanSpaces: vi.fn().mockResolvedValue({ plugins: [chiefPlugin], conflicts: [] }),
      getDeactivatedPluginIds: vi.fn().mockResolvedValue(['my-plugin']),
    });

    await syncSpacePluginsCatalog(deps);

    expect(deps.registerPlugin).not.toHaveBeenCalled();
  });

  it('does NOT register activated team plugin that was explicitly deactivated', async () => {
    const teamPlugin = {
      pluginId: 'team-plugin',
      manifest: { id: 'team-plugin', name: 'Team Plugin', entryPoint: 'index.tsx', version: '0.1.0', maturity: 'labs' },
      source: 'export default function() { return null; }',
      spaceName: 'AcmeConsulting',
      spacePath: '/Users/test/workspace/Work/AcmeConsulting',
    };

    const deps = createMockDeps({
      scanSpaces: vi.fn().mockResolvedValue({ plugins: [teamPlugin], conflicts: [] }),
      getActivatedPluginIds: vi.fn().mockResolvedValue(['team-plugin']),
      getDeactivatedPluginIds: vi.fn().mockResolvedValue(['team-plugin']),
    });

    await syncSpacePluginsCatalog(deps);

    expect(deps.registerPlugin).not.toHaveBeenCalled();
  });

  it('re-registers already-active Chief-of-Staff plugins for hot-reload', async () => {
    const chiefPlugin = {
      pluginId: 'my-plugin',
      manifest: { id: 'my-plugin', name: 'My Plugin', entryPoint: 'index.tsx', version: '0.1.0', maturity: 'labs' },
      source: 'export default function() { return <div>Updated</div>; }',
      spaceName: 'Chief-of-Staff',
      spacePath: '/Users/test/workspace/Chief-of-Staff',
    };

    const deps = createMockDeps({
      scanSpaces: vi.fn().mockResolvedValue({ plugins: [chiefPlugin], conflicts: [] }),
      getRegisteredPlugins: vi.fn().mockReturnValue([{ manifest: { id: 'my-plugin' } }]),
    });

    await syncSpacePluginsCatalog(deps);

    // Active plugins are unconditionally re-compiled and re-registered
    // so that source changes on disk are picked up (hot-reload).
    expect(deps.compileSource).toHaveBeenCalledWith(chiefPlugin.source);
    expect(deps.registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'my-plugin' }),
      chiefPlugin.source,
    );
  });
});

describe('Hot-reload and cleanup', () => {
  function createMockDeps(overrides: Partial<SpacePluginsControllerDeps> = {}): SpacePluginsControllerDeps {
    return {
      scanSpaces: vi.fn().mockResolvedValue({ plugins: [], conflicts: [] }),
      onSpacePluginsChanged: vi.fn(() => () => {}),
      getActivatedPluginIds: vi.fn().mockResolvedValue([]),
      getDeactivatedPluginIds: vi.fn().mockResolvedValue([]),
      getPendingReviewPluginIds: vi.fn().mockResolvedValue([]),
      indexReadme: vi.fn().mockResolvedValue(undefined),
      deindexReadme: vi.fn().mockResolvedValue(undefined),
      getRegisteredPlugins: vi.fn().mockReturnValue([]),
      registerPlugin: vi.fn().mockReturnValue({ ok: true }),
      unregisterPlugin: vi.fn().mockReturnValue(true),
      getCatalogPlugins: vi.fn().mockReturnValue([]),
      setCatalogPlugins: vi.fn(),
      compileSource: vi.fn().mockResolvedValue(true),
      ...overrides,
    };
  }

  it('re-registers active team Space plugin with updated source on re-scan', async () => {
    const updatedSource = 'export default function() { return <div>v2</div>; }';
    const teamPlugin = {
      pluginId: 'team-plugin',
      manifest: { id: 'team-plugin', name: 'Team Plugin', entryPoint: 'index.tsx', version: '0.2.0', maturity: 'labs' },
      source: updatedSource,
      spaceName: 'AcmeConsulting',
      spacePath: '/Users/test/workspace/Work/AcmeConsulting',
    };

    const deps = createMockDeps({
      scanSpaces: vi.fn().mockResolvedValue({ plugins: [teamPlugin], conflicts: [] }),
      getActivatedPluginIds: vi.fn().mockResolvedValue(['team-plugin']),
      // Plugin is already registered from a previous scan
      getRegisteredPlugins: vi.fn().mockReturnValue([{ manifest: { id: 'team-plugin' } }]),
    });

    await syncSpacePluginsCatalog(deps);

    expect(deps.compileSource).toHaveBeenCalledWith(updatedSource);
    expect(deps.registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'team-plugin', version: '0.2.0' }),
      updatedSource,
    );
  });

  it('unregisters Space plugin deleted from disk on re-scan', async () => {
    const deps = createMockDeps({
      // New scan returns no plugins (the plugin was deleted from disk)
      scanSpaces: vi.fn().mockResolvedValue({ plugins: [], conflicts: [] }),
      // The plugin was previously in the catalog (from a prior scan)
      getCatalogPlugins: vi.fn().mockReturnValue([
        {
          manifest: { id: 'deleted-plugin', name: 'Deleted Plugin', entryPoint: 'index.tsx', version: '0.1.0', maturity: 'labs' },
          source: 'export default function() { return null; }',
          spacePath: '/Users/test/workspace/Chief-of-Staff',
          isActive: true,
        },
      ]),
      // Plugin is still registered from the previous scan
      getRegisteredPlugins: vi.fn().mockReturnValue([{ manifest: { id: 'deleted-plugin' } }]),
    });

    await syncSpacePluginsCatalog(deps);

    expect(deps.unregisterPlugin).toHaveBeenCalledWith('deleted-plugin');
    expect(deps.deindexReadme).toHaveBeenCalledWith('deleted-plugin', '/Users/test/workspace/Chief-of-Staff');
  });

  it('does NOT unregister plugins still present in scan', async () => {
    const chiefPlugin = {
      pluginId: 'my-plugin',
      manifest: { id: 'my-plugin', name: 'My Plugin', entryPoint: 'index.tsx', version: '0.1.0', maturity: 'labs' },
      source: 'export default function() { return null; }',
      spaceName: 'Chief-of-Staff',
      spacePath: '/Users/test/workspace/Chief-of-Staff',
    };

    const deps = createMockDeps({
      scanSpaces: vi.fn().mockResolvedValue({ plugins: [chiefPlugin], conflicts: [] }),
      // Plugin was in previous catalog and is still discovered
      getCatalogPlugins: vi.fn().mockReturnValue([
        {
          manifest: { id: 'my-plugin', name: 'My Plugin', entryPoint: 'index.tsx', version: '0.1.0', maturity: 'labs' },
          source: 'export default function() { return null; }',
          spacePath: '/Users/test/workspace/Chief-of-Staff',
          isActive: true,
        },
      ]),
    });

    await syncSpacePluginsCatalog(deps);

    expect(deps.unregisterPlugin).not.toHaveBeenCalled();
  });

  it('does NOT clean up locally-created plugins that are not in the catalog', async () => {
    const deps = createMockDeps({
      // Scan returns no space plugins
      scanSpaces: vi.fn().mockResolvedValue({ plugins: [], conflicts: [] }),
      // Catalog is empty (local plugins are never in the catalog)
      getCatalogPlugins: vi.fn().mockReturnValue([]),
      // But there IS a locally-created plugin in the registry
      getRegisteredPlugins: vi.fn().mockReturnValue([{ manifest: { id: 'local-editor-plugin' } }]),
    });

    await syncSpacePluginsCatalog(deps);

    // Local plugins should NOT be unregistered — cleanup only targets Space-origin plugins
    expect(deps.unregisterPlugin).not.toHaveBeenCalled();
  });
});
