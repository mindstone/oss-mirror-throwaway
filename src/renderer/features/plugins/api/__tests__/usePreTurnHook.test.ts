import { beforeEach, describe, expect, it, vi } from 'vitest';

const effectCleanups: Array<() => void> = [];

const registerPluginContext = vi.fn();
const getPluginContexts = vi.fn();
const usePluginId = vi.fn();
const getRegisteredPlugin = vi.fn();

vi.mock('react', () => ({
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (typeof cleanup === 'function') {
      effectCleanups.push(cleanup);
    }
  },
  useRef: <T,>(initial: T) => ({ current: initial }),
}));

vi.mock('../pluginContextRegistry', () => ({
  registerPluginContext,
  getPluginContexts,
}));

vi.mock('../PluginContext', () => ({
  usePluginId,
}));

vi.mock('../../manifest/pluginRegistry', () => ({
  getRegisteredPlugin,
}));

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('usePreTurnHook', () => {
  let usePreTurnHook: typeof import('../usePreTurnHook').usePreTurnHook;
  let unregisterSpy: ReturnType<typeof vi.fn>;
  let getContextsSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    effectCleanups.length = 0;
    unregisterSpy = vi.fn();
    getContextsSpy = vi.fn(async () => ({ contexts: [] }));

    registerPluginContext.mockReset();
    registerPluginContext.mockReturnValue(unregisterSpy);
    getPluginContexts.mockReset();
    getPluginContexts.mockReturnValue([
      {
        pluginId: 'meeting-prep',
        pluginName: 'Meeting Prep',
        content: 'Meeting prep context',
        priority: 2,
      },
    ]);
    usePluginId.mockReset();
    usePluginId.mockReturnValue('meeting-prep');
    getRegisteredPlugin.mockReset();
    getRegisteredPlugin.mockReturnValue({
      manifest: { name: 'Meeting Prep' },
    });

    (globalThis as { window?: unknown }).window = {
      pluginsApi: {
        getContexts: getContextsSpy,
      },
    };

    ({ usePreTurnHook } = await import('../usePreTurnHook'));
  });

  it('registers plugin context provider with plugin id/name/priority', async () => {
    usePreTurnHook({
      getContext: () => 'Pre-turn context',
      priority: 7,
    });

    await flushPromises();

    expect(registerPluginContext).toHaveBeenCalledTimes(1);
    const call = registerPluginContext.mock.calls[0];
    expect(call[0]).toBe('meeting-prep');
    expect(call[1]).toBe('Meeting Prep');
    expect(call[3]).toBe(7);
    expect(typeof call[2]).toBe('function');
    expect((call[2] as () => string | null)()).toBe('Pre-turn context');

    expect(getContextsSpy).toHaveBeenCalled();
    expect(getContextsSpy).toHaveBeenCalledWith({
      contexts: getPluginContexts.mock.results[0]?.value ?? [],
    });
  });

  it('falls back to plugin id when plugin manifest is unavailable', async () => {
    getRegisteredPlugin.mockReturnValue(undefined);

    usePreTurnHook({
      getContext: () => 'Fallback context',
    });

    await flushPromises();

    expect(registerPluginContext).toHaveBeenCalledTimes(1);
    expect(registerPluginContext.mock.calls[0][1]).toBe('meeting-prep');
  });

  it('unregisters context provider during cleanup', async () => {
    usePreTurnHook({
      getContext: () => 'Cleanup context',
    });

    await flushPromises();

    for (const cleanup of effectCleanups) {
      cleanup();
    }

    expect(unregisterSpy).toHaveBeenCalledTimes(1);
  });
});
