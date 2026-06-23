import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const FLOW_PANELS_STORAGE_KEY = 'flow-panels-state';

// Mock window.localStorage for Node environment
const createMockLocalStorage = (storage: Record<string, string>) => ({
  getItem: (key: string) => storage[key] ?? null,
  setItem: (key: string, value: string) => { storage[key] = value; },
  removeItem: (key: string) => { delete storage[key]; },
  clear: () => { Object.keys(storage).forEach(k => delete storage[k]); },
  length: 0,
  key: () => null,
});

describe('FlowPanelsProvider localStorage migration', () => {
  let mockStorage: Record<string, string>;
  const originalWindow = global.window;

  beforeEach(() => {
    vi.resetModules();
    mockStorage = {};
    // Create a minimal window mock with localStorage
    (global as unknown as { window: unknown }).window = {
      localStorage: createMockLocalStorage(mockStorage),
    };
  });

  afterEach(() => {
    (global as unknown as { window: unknown }).window = originalWindow;
    vi.restoreAllMocks();
  });

  it('returns home as default when no localStorage', async () => {
    const { readFlowPanelsState } = await import('../FlowPanelsProvider');
    const state = readFlowPanelsState();
    expect(state.surface).toBe('home');
  });

  it('migrates surface: workspace to home (default)', async () => {
    mockStorage[FLOW_PANELS_STORAGE_KEY] = JSON.stringify({
      history: true,
      surface: 'workspace',
    });
    
    const { readFlowPanelsState } = await import('../FlowPanelsProvider');
    const state = readFlowPanelsState();
    // 'workspace' is not a valid FlowSurface, so it falls back to default ('home')
    expect(state.surface).toBe('home');
    expect(state.history).toBe(true);
  });

  it('preserves surface: library unchanged', async () => {
    mockStorage[FLOW_PANELS_STORAGE_KEY] = JSON.stringify({
      history: false,
      surface: 'library',
    });
    
    const { readFlowPanelsState } = await import('../FlowPanelsProvider');
    const state = readFlowPanelsState();
    expect(state.surface).toBe('library');
    expect(state.history).toBe(false);
  });

  it('migrates legacy { workspace: true } to surface: library', async () => {
    mockStorage[FLOW_PANELS_STORAGE_KEY] = JSON.stringify({
      history: true,
      workspace: true,
    });
    
    const { readFlowPanelsState } = await import('../FlowPanelsProvider');
    const state = readFlowPanelsState();
    expect(state.surface).toBe('library');
  });

  it('falls back to home for invalid surface values', async () => {
    mockStorage[FLOW_PANELS_STORAGE_KEY] = JSON.stringify({
      history: true,
      surface: 'invalid-surface',
    });
    
    const { readFlowPanelsState } = await import('../FlowPanelsProvider');
    const state = readFlowPanelsState();
    expect(state.surface).toBe('home');
  });

  it('preserves other valid surfaces like sessions', async () => {
    mockStorage[FLOW_PANELS_STORAGE_KEY] = JSON.stringify({
      history: true,
      surface: 'sessions',
    });
    
    const { readFlowPanelsState } = await import('../FlowPanelsProvider');
    const state = readFlowPanelsState();
    expect(state.surface).toBe('sessions');
  });
});
