import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';

// Track subscribed event listeners
const eventListeners = new Map<string, Set<(...args: unknown[]) => void>>();

vi.mock('../workspaceWatcherService', () => ({
  workspaceWatcherService: {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (!eventListeners.has(event)) eventListeners.set(event, new Set());
      eventListeners.get(event)?.add(listener);
    }),
    off: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      eventListeners.get(event)?.delete(listener);
    }),
  },
}));

const { startPluginWatcherSubscriber } = await import('../pluginWatcherSubscriber');

function emitEvent(event: string, ...args: unknown[]) {
  const listeners = eventListeners.get(event);
  if (listeners) {
    for (const listener of listeners) {
      listener(...args);
    }
  }
}

describe('pluginWatcherSubscriber', () => {
  let mockWindow: { isDestroyed: ReturnType<typeof vi.fn>; webContents: { send: ReturnType<typeof vi.fn> } };
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    eventListeners.clear();
    mockWindow = {
      isDestroyed: vi.fn().mockReturnValue(false),
      webContents: { send: vi.fn() },
    };
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    vi.useRealTimers();
  });

  it('subscribes to workspace watcher events', () => {
    cleanup = startPluginWatcherSubscriber(() => mockWindow as never);

    expect(eventListeners.has('file:added')).toBe(true);
    expect(eventListeners.has('file:changed')).toBe(true);
    expect(eventListeners.has('file:removed')).toBe(true);
  });

  it('broadcasts plugins:space-changed when manifest.json changes in plugins/ directory', () => {
    cleanup = startPluginWatcherSubscriber(() => mockWindow as never);

    emitEvent('file:changed', '/workspace/MySpace/plugins/meeting-prep/manifest.json');
    vi.advanceTimersByTime(600);

    expect(mockWindow.webContents.send).toHaveBeenCalledWith('plugins:space-changed');
  });

  it('broadcasts plugins:space-changed when index.tsx is added in plugins/ directory', () => {
    cleanup = startPluginWatcherSubscriber(() => mockWindow as never);

    emitEvent('file:added', '/workspace/MySpace/plugins/new-plugin/index.tsx');
    vi.advanceTimersByTime(600);

    expect(mockWindow.webContents.send).toHaveBeenCalledWith('plugins:space-changed');
  });

  it('broadcasts plugins:space-changed when plugin file is removed', () => {
    cleanup = startPluginWatcherSubscriber(() => mockWindow as never);

    emitEvent('file:removed', '/workspace/MySpace/plugins/old-plugin/manifest.json');
    vi.advanceTimersByTime(600);

    expect(mockWindow.webContents.send).toHaveBeenCalledWith('plugins:space-changed');
  });

  it('does not broadcast for non-plugin file changes', () => {
    cleanup = startPluginWatcherSubscriber(() => mockWindow as never);

    // File in memory/ not plugins/
    emitEvent('file:changed', '/workspace/MySpace/memory/notes.md');
    vi.advanceTimersByTime(600);

    expect(mockWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('does not broadcast for non-relevant files in plugins/ directory', () => {
    cleanup = startPluginWatcherSubscriber(() => mockWindow as never);

    // A random file that's not manifest.json, index.tsx, or README.md
    emitEvent('file:changed', '/workspace/MySpace/plugins/meeting-prep/notes.txt');
    vi.advanceTimersByTime(600);

    expect(mockWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('debounces rapid changes', () => {
    cleanup = startPluginWatcherSubscriber(() => mockWindow as never);

    // Fire multiple events rapidly
    emitEvent('file:changed', '/workspace/MySpace/plugins/plugin-a/manifest.json');
    emitEvent('file:changed', '/workspace/MySpace/plugins/plugin-a/index.tsx');
    emitEvent('file:added', '/workspace/MySpace/plugins/plugin-b/manifest.json');

    // Before debounce fires
    vi.advanceTimersByTime(400);
    expect(mockWindow.webContents.send).not.toHaveBeenCalled();

    // After debounce fires
    vi.advanceTimersByTime(200);
    expect(mockWindow.webContents.send).toHaveBeenCalledTimes(1);
  });

  it('cleanup function unsubscribes from events', () => {
    cleanup = startPluginWatcherSubscriber(() => mockWindow as never);

    expect(eventListeners.get('file:added')?.size).toBeGreaterThan(0);
    expect(eventListeners.get('file:changed')?.size).toBeGreaterThan(0);
    expect(eventListeners.get('file:removed')?.size).toBeGreaterThan(0);

    cleanup();
    cleanup = null;

    expect(eventListeners.get('file:added')?.size).toBe(0);
    expect(eventListeners.get('file:changed')?.size).toBe(0);
    expect(eventListeners.get('file:removed')?.size).toBe(0);
  });

  it('does not broadcast when window is null', () => {
    cleanup = startPluginWatcherSubscriber(() => null);

    emitEvent('file:changed', '/workspace/MySpace/plugins/plugin/manifest.json');
    vi.advanceTimersByTime(600);

    expect(mockWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('does not broadcast when window is destroyed', () => {
    mockWindow.isDestroyed.mockReturnValue(true);
    cleanup = startPluginWatcherSubscriber(() => mockWindow as never);

    emitEvent('file:changed', '/workspace/MySpace/plugins/plugin/manifest.json');
    vi.advanceTimersByTime(600);

    expect(mockWindow.webContents.send).not.toHaveBeenCalled();
  });
});
