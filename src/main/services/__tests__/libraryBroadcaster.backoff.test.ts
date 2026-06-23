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

const WATCHER_DEBOUNCE_MS = 8_000;
const MAX_WAIT_MS = 30_000;

/**
 * Drive a sustained event storm by emitting one watcher event every `intervalMs`,
 * for `durationMs` total. `intervalMs` must be < WATCHER_DEBOUNCE_MS so the debounce
 * timer keeps resetting and the only flush path is MAX_WAIT_MS.
 */
async function runStorm(durationMs: number, intervalMs = 200): Promise<void> {
  let elapsed = 0;
  while (elapsed < durationMs) {
    workspaceWatcherService.emit('file:added', `/workspace/storm/file-${elapsed}.md`);
    await vi.advanceTimersByTimeAsync(intervalMs);
    elapsed += intervalMs;
  }
}

describe('libraryBroadcaster adaptive backoff', () => {
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

  it('uses MAX_WAIT_MS for the first flush of a sustained storm', async () => {
    await runStorm(MAX_WAIT_MS + 500);

    expect(mockBroadcastToAllWindows).toHaveBeenCalledTimes(1);
  });

  it('doubles MAX_WAIT_MS between consecutive ceiling flushes', async () => {
    // First flush at MAX_WAIT_MS, second flush should require ~MAX_WAIT_MS * 2 more time
    await runStorm(MAX_WAIT_MS + 500);
    expect(mockBroadcastToAllWindows).toHaveBeenCalledTimes(1);

    // Continue the storm; with backoff, the second emit should NOT fire at the
    // original MAX_WAIT_MS interval.
    await runStorm(MAX_WAIT_MS - 500);
    expect(mockBroadcastToAllWindows).toHaveBeenCalledTimes(1);

    // Continuing past the doubled ceiling (~60s total since first flush) should fire emit #2.
    await runStorm(MAX_WAIT_MS + 500);
    expect(mockBroadcastToAllWindows).toHaveBeenCalledTimes(2);
  });

  it('resets backoff when a quiet period reaches WATCHER_DEBOUNCE_MS', async () => {
    // Drive into backoff: two ceiling flushes
    await runStorm(MAX_WAIT_MS + 500);
    await runStorm(MAX_WAIT_MS * 2 + 500);
    expect(mockBroadcastToAllWindows).toHaveBeenCalledTimes(2);

    mockBroadcastToAllWindows.mockClear();

    // Single event followed by silence > WATCHER_DEBOUNCE_MS: should fire via debounce
    workspaceWatcherService.emit('file:added', '/workspace/storm/lone.md');
    await vi.advanceTimersByTimeAsync(WATCHER_DEBOUNCE_MS + 100);

    expect(mockBroadcastToAllWindows).toHaveBeenCalledTimes(1);

    // Backoff is now reset: the next storm should emit again at the BASE
    // MAX_WAIT_MS, not at the previously-doubled ceiling.
    mockBroadcastToAllWindows.mockClear();
    await runStorm(MAX_WAIT_MS + 500);
    expect(mockBroadcastToAllWindows).toHaveBeenCalledTimes(1);
  });

  it('caps backoff at five minutes regardless of storm length', async () => {
    // Burn through enough doublings to exceed the cap (30s -> 60s -> 120s -> 240s -> 480s).
    // 480_000 > MAX_WAIT_BACKOFF_CAP_MS (300_000), so the cap clamps the next
    // ceiling. Run a long storm; verify the gap between flush N and N+1 never
    // exceeds 5 min by a meaningful margin.
    await runStorm(MAX_WAIT_MS + 500); // emit 1 at 30s
    await runStorm(MAX_WAIT_MS * 2 + 500); // emit 2 at ~90s
    await runStorm(MAX_WAIT_MS * 4 + 500); // emit 3 at ~210s
    await runStorm(MAX_WAIT_MS * 8 + 500); // emit 4 at ~450s (would be 240s without cap)
    expect(mockBroadcastToAllWindows.mock.calls.length).toBeGreaterThanOrEqual(3);

    // Now continue at the cap (5min). 5min should produce exactly one more emit.
    const callsBefore = mockBroadcastToAllWindows.mock.calls.length;
    await runStorm(5 * 60_000 + 500);
    const callsAfter = mockBroadcastToAllWindows.mock.calls.length;
    expect(callsAfter - callsBefore).toBeGreaterThanOrEqual(1);
    // And critically, NOT exceeding what 5min worth of cap would produce.
    expect(callsAfter - callsBefore).toBeLessThanOrEqual(2);
  });
});
