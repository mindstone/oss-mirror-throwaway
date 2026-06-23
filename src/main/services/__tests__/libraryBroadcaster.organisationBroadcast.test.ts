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

describe('libraryBroadcaster organisation-frontmatter propagation', () => {
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

  it('broadcasts a library:changed event when README frontmatter changes', async () => {
    workspaceWatcherService.emit('file:changed', '/workspace/work/Mindstone/General/README.md');

    await vi.advanceTimersByTimeAsync(8_000);

    expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(
      'library:changed',
      expect.objectContaining({
        affectsTree: false,
        writerKind: 'file-watcher',
        changedPath: 'work/Mindstone/General/README.md',
        source: 'watcher',
      }),
    );
  });
});
