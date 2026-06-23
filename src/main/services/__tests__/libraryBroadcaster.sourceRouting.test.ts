import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockBroadcastToAllWindows = vi.fn();
const mockGetSettings = vi.fn(() => ({ coreDirectory: '/workspace' }));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: () => mockGetSettings(),
}));

vi.mock('@core/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  // boundedWorkspaceFs (transitively loaded via safeWalkDirectory — S4.1a) needs this.
  createScopedLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../utils/broadcastHelpers', () => ({
  broadcastToAllWindows: (...args: unknown[]) => mockBroadcastToAllWindows(...args),
}));

const { libraryBroadcaster } = await import('../libraryBroadcaster');
const { workspaceWatcherService } = await import('../workspaceWatcherService');

describe('libraryBroadcaster source routing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockBroadcastToAllWindows.mockClear();
    mockGetSettings.mockReturnValue({ coreDirectory: '/workspace' });
    libraryBroadcaster.start();
  });

  afterEach(() => {
    libraryBroadcaster.stop();
    vi.useRealTimers();
  });

  it('broadcasts user-source events on the leading edge', () => {
    libraryBroadcaster.broadcast({
      affectsTree: true,
      writerKind: 'editor',
      changedPath: '/workspace/new-space/README.md',
    }, 'user');

    expect(mockBroadcastToAllWindows).toHaveBeenCalledTimes(1);
    expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(
      'library:changed',
      expect.objectContaining({
        affectsTree: true,
        writerKind: 'editor',
        changedPath: 'new-space/README.md',
        source: 'user',
      }),
    );
  });

  it('emits agent file-write events immediately on the user path with writerKind agent', () => {
    // Mirrors agentTurnExecute's onFileChanged callback: agent writes route
    // through the broadcaster's 'user' (leading-edge) path, preserving
    // writerKind 'agent', affectsTree false, and normalizing the path.
    libraryBroadcaster.broadcast({
      affectsTree: false,
      writerKind: 'agent',
      changedPath: '/workspace/notes/agent-output.md',
    }, 'user');

    expect(mockBroadcastToAllWindows).toHaveBeenCalledTimes(1);
    expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(
      'library:changed',
      expect.objectContaining({
        affectsTree: false,
        writerKind: 'agent',
        changedPath: 'notes/agent-output.md',
        source: 'user',
      }),
    );
  });

  it('coalesces watcher-source events into one broadcast after 8 seconds', async () => {
    for (let index = 0; index < 5; index += 1) {
      workspaceWatcherService.emit('file:added', `/workspace/storm-${index}.md`);
    }

    expect(mockBroadcastToAllWindows).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(7_999);
    expect(mockBroadcastToAllWindows).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(mockBroadcastToAllWindows).toHaveBeenCalledTimes(1);
    expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(
      'library:changed',
      expect.objectContaining({
        affectsTree: true,
        writerKind: 'file-watcher',
        source: 'watcher',
      }),
    );
  });
});
