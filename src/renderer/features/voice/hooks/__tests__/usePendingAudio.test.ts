import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Shared mutable state for our lightweight React-hook mock
// vi.hoisted() ensures these are available inside vi.mock() factories
// ---------------------------------------------------------------------------
const {
  states,
  refs,
  hookIdx,
  resetAll,
  resetIndices,
} = vi.hoisted(() => {
  const states: Array<{ value: unknown; setter: (v: unknown) => void }> = [];
  const refs: Array<{ current: unknown }> = [];
  const hookIdx = { state: 0, ref: 0 };

  function resetIndices() {
    hookIdx.state = 0;
    hookIdx.ref = 0;
  }

  function resetAll() {
    states.length = 0;
    refs.length = 0;
    resetIndices();
  }

  return { states, refs, hookIdx, resetAll, resetIndices };
});

// ---------------------------------------------------------------------------
// Mock React — minimal controlled implementations for hooks
// ---------------------------------------------------------------------------
vi.mock('react', () => ({
  useState: (init: unknown) => {
    const idx = hookIdx.state++;
    if (states.length <= idx) {
      const resolved = typeof init === 'function' ? (init as () => unknown)() : init;
      const slot = {
        value: resolved,
        setter: (v: unknown) => {
          slot.value = typeof v === 'function' ? (v as (prev: unknown) => unknown)(slot.value) : v;
        },
      };
      states.push(slot);
    }
    return [states[idx].value, states[idx].setter];
  },
  useRef: (init: unknown) => {
    const idx = hookIdx.ref++;
    if (refs.length <= idx) {
      refs.push({ current: init });
    }
    return refs[idx];
  },
  useCallback: (fn: unknown) => fn,
  useEffect: () => {}, // no-op — we test returned functions directly
}));

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------
vi.mock('@renderer/hooks/useOnlineStatus', () => ({
  useOnlineStatus: vi.fn(() => true),
}));

vi.mock('@renderer/features/agent-session/store', () => ({
  getSessionStoreState: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import SUT (after mocks are declared — vi.mock is hoisted)
// ---------------------------------------------------------------------------
import { usePendingAudio, type VoiceErrorCategory } from '../usePendingAudioCount';
import { getSessionStoreState } from '@renderer/features/agent-session/store';

// ---------------------------------------------------------------------------
// voiceApi mock
// ---------------------------------------------------------------------------
// Mock voiceApi — `vi.fn()` without type params to avoid TS2558 cascading errors.
// Type safety is enforced by the test assertions themselves.
const mockVoiceApi = {
  getPendingAudio: vi.fn(),
  retryPendingAudio: vi.fn(),
  deletePendingAudio: vi.fn(),
  revealPendingAudio: vi.fn(),
};

// Ref indices (determined by declaration order in usePendingAudioCount.ts)
const REF_IDX = {
  errorMap: 0,
  errorCategoryMap: 1,
  retryingSet: 2,
  backoffMs: 3,
  backoffTimer: 4,
  isRetrying: 5,
  lastRetryAt: 6,
  files: 7,
} as const;

// Constants matching the hook source
const INITIAL_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 600_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** "Render" the hook — resets call indices so useState/useRef return in order */
function render() {
  resetIndices();
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return usePendingAudio();
}

/** Seed files into the hook state (simulates a successful refresh) */
async function seedFiles(
  files: Array<{ filePath: string; createdAt: number; source: 'voice-mode' | 'inline-mic'; sessionId?: string }>,
) {
  mockVoiceApi.getPendingAudio.mockResolvedValueOnce(files);
  const hook = render();
  await hook.refresh();
  // Re-render so filesRef.current picks up the new state
  return render();
}

function getErrorMap(): Map<string, string> {
  return refs[REF_IDX.errorMap].current as Map<string, string>;
}

function getErrorCategoryMap(): Map<string, VoiceErrorCategory> {
  return refs[REF_IDX.errorCategoryMap].current as Map<string, VoiceErrorCategory>;
}

function getBackoffMs(): number {
  return refs[REF_IDX.backoffMs].current as number;
}

function _getLastRetryAt(): number {
  return refs[REF_IDX.lastRetryAt].current as number;
}

function setLastRetryAt(value: number): void {
  refs[REF_IDX.lastRetryAt].current = value;
}

function mockSessionStore() {
  const store = {
    resetSession: vi.fn(() => 'new-session-id'),
    setDraftForSession: vi.fn(),
    renameSession: vi.fn(),
    setShowConversation: vi.fn(),
  };
  vi.mocked(getSessionStoreState).mockReturnValue(store as never);
  return store;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('usePendingAudio', () => {
  beforeEach(() => {
    resetAll();
    vi.clearAllMocks();
    // Install voiceApi on globalThis.window
    (globalThis as Record<string, unknown>).window = { voiceApi: mockVoiceApi };
    // Default: getPendingAudio returns empty
    mockVoiceApi.getPendingAudio.mockResolvedValue([]);
    mockVoiceApi.deletePendingAudio.mockResolvedValue(undefined);
    mockVoiceApi.retryPendingAudio.mockResolvedValue({ success: false, error: 'default mock' });
    mockVoiceApi.revealPendingAudio.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
  });

  // -------------------------------------------------------------------------
  // retryFile
  // -------------------------------------------------------------------------
  describe('retryFile', () => {
    const inlineMicFile = {
      filePath: '/tmp/audio/recording-1.webm',
      createdAt: Date.now() - 30_000,
      source: 'inline-mic' as const,
    };

    it('sets lastError on failure (IPC returns error)', async () => {
      mockVoiceApi.retryPendingAudio.mockResolvedValueOnce({
        success: false,
        error: 'Insufficient credits',
      });
      // Refresh after retryFile also returns the file
      mockVoiceApi.getPendingAudio.mockResolvedValue([inlineMicFile]);

      const hook = await seedFiles([inlineMicFile]);
      await hook.retryFile(inlineMicFile.filePath);

      expect(mockVoiceApi.retryPendingAudio).toHaveBeenCalledWith({ filePath: inlineMicFile.filePath });
      expect(getErrorMap().get(inlineMicFile.filePath)).toBe('Insufficient credits');
    });

    it('sets lastError on failure (IPC throws)', async () => {
      mockVoiceApi.retryPendingAudio.mockRejectedValueOnce(new Error('Network error'));
      mockVoiceApi.getPendingAudio.mockResolvedValue([inlineMicFile]);

      const hook = await seedFiles([inlineMicFile]);
      await hook.retryFile(inlineMicFile.filePath);

      expect(getErrorMap().get(inlineMicFile.filePath)).toBe('Network error');
    });

    it('clears error and removes file on success', async () => {
      const store = mockSessionStore();

      // Pre-seed an error for this file
      mockVoiceApi.getPendingAudio.mockResolvedValue([inlineMicFile]);
      const hook1 = await seedFiles([inlineMicFile]);
      getErrorMap().set(inlineMicFile.filePath, 'Previous error');

      mockVoiceApi.retryPendingAudio.mockResolvedValueOnce({
        success: true,
        transcript: 'Hello world',
      });
      // After success, the file is deleted so refresh returns empty
      mockVoiceApi.getPendingAudio.mockResolvedValueOnce([]);

      await hook1.retryFile(inlineMicFile.filePath);

      expect(mockVoiceApi.deletePendingAudio).toHaveBeenCalledWith({ filePath: inlineMicFile.filePath });
      expect(getErrorMap().has(inlineMicFile.filePath)).toBe(false);
      expect(store.resetSession).toHaveBeenCalled();
      expect(store.setDraftForSession).toHaveBeenCalledWith('new-session-id', 'Hello world');
      expect(store.renameSession).toHaveBeenCalledWith('new-session-id', 'Recovered voice note');
    });

    it('resets global backoff on successful retry', async () => {
      mockSessionStore();
      mockVoiceApi.getPendingAudio.mockResolvedValue([inlineMicFile]);

      // Manually inflate backoff
      const hook = await seedFiles([inlineMicFile]);
      refs[REF_IDX.backoffMs].current = 240_000;

      mockVoiceApi.retryPendingAudio.mockResolvedValueOnce({
        success: true,
        transcript: 'test',
      });

      await hook.retryFile(inlineMicFile.filePath);

      expect(getBackoffMs()).toBe(INITIAL_BACKOFF_MS);
    });

    it('retries voice-mode files (same as inline-mic)', async () => {
      const voiceModeFile = {
        filePath: '/tmp/audio/vm-1.webm',
        createdAt: Date.now(),
        source: 'voice-mode' as const,
      };
      mockVoiceApi.getPendingAudio.mockResolvedValue([voiceModeFile]);
      mockVoiceApi.retryPendingAudio.mockResolvedValue({
        success: true,
        transcript: 'recovered voice note',
      });

      const hook = await seedFiles([voiceModeFile]);
      await hook.retryFile(voiceModeFile.filePath);

      expect(mockVoiceApi.retryPendingAudio).toHaveBeenCalledWith({
        filePath: voiceModeFile.filePath,
      });
    });

    it('skips unknown file paths', async () => {
      mockVoiceApi.getPendingAudio.mockResolvedValue([inlineMicFile]);

      const hook = await seedFiles([inlineMicFile]);
      await hook.retryFile('/tmp/audio/nonexistent.webm');

      expect(mockVoiceApi.retryPendingAudio).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // dismissFile
  // -------------------------------------------------------------------------
  describe('dismissFile', () => {
    const file = {
      filePath: '/tmp/audio/note-1.webm',
      createdAt: Date.now(),
      source: 'inline-mic' as const,
    };

    it('calls delete IPC and refreshes the list', async () => {
      const hook = render();

      await hook.dismissFile(file.filePath);

      expect(mockVoiceApi.deletePendingAudio).toHaveBeenCalledWith({ filePath: file.filePath });
      // refresh() is called after delete
      expect(mockVoiceApi.getPendingAudio).toHaveBeenCalled();
    });

    it('clears the error entry for the dismissed file', async () => {
      const hook = render();
      getErrorMap().set(file.filePath, 'some error');

      await hook.dismissFile(file.filePath);

      expect(getErrorMap().has(file.filePath)).toBe(false);
    });

    it('still refreshes even if delete throws', async () => {
      mockVoiceApi.deletePendingAudio.mockRejectedValueOnce(new Error('File not found'));

      const hook = render();
      await hook.dismissFile(file.filePath);

      // Refresh should still be called despite the error
      expect(mockVoiceApi.getPendingAudio).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // dismissAll
  // -------------------------------------------------------------------------
  describe('dismissAll', () => {
    const files = [
      { filePath: '/tmp/audio/a.webm', createdAt: 1, source: 'inline-mic' as const },
      { filePath: '/tmp/audio/b.webm', createdAt: 2, source: 'voice-mode' as const },
      { filePath: '/tmp/audio/c.webm', createdAt: 3, source: 'inline-mic' as const },
    ];

    it('deletes all files via IPC', async () => {
      mockVoiceApi.getPendingAudio.mockResolvedValue(files);

      const hook = await seedFiles(files);

      // After dismissAll, the list should be empty
      mockVoiceApi.getPendingAudio.mockResolvedValueOnce([]);
      await hook.dismissAll();

      expect(mockVoiceApi.deletePendingAudio).toHaveBeenCalledTimes(files.length);
      for (const file of files) {
        expect(mockVoiceApi.deletePendingAudio).toHaveBeenCalledWith({ filePath: file.filePath });
      }
    });

    it('continues deleting even if one file fails', async () => {
      mockVoiceApi.getPendingAudio.mockResolvedValue(files);
      const hook = await seedFiles(files);

      // Second delete fails
      mockVoiceApi.deletePendingAudio
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce(undefined);

      mockVoiceApi.getPendingAudio.mockResolvedValueOnce([]);
      await hook.dismissAll();

      // All 3 deletes attempted
      expect(mockVoiceApi.deletePendingAudio).toHaveBeenCalledTimes(files.length);
    });

    it('clears error entries for all files', async () => {
      mockVoiceApi.getPendingAudio.mockResolvedValue(files);
      const hook = await seedFiles(files);

      getErrorMap().set(files[0].filePath, 'err-a');
      getErrorMap().set(files[2].filePath, 'err-c');

      mockVoiceApi.getPendingAudio.mockResolvedValueOnce([]);
      await hook.dismissAll();

      expect(getErrorMap().size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // retryAllInlineMic — source filtering
  // -------------------------------------------------------------------------
  describe('retryAllInlineMic — auto-retry only processes inline-mic files', () => {
    const mixedFiles = [
      { filePath: '/tmp/audio/im-1.webm', createdAt: 1, source: 'inline-mic' as const },
      { filePath: '/tmp/audio/vm-1.webm', createdAt: 2, source: 'voice-mode' as const },
      { filePath: '/tmp/audio/im-2.webm', createdAt: 3, source: 'inline-mic' as const },
    ];

    it('only retries inline-mic files, skips voice-mode', async () => {
      mockVoiceApi.getPendingAudio.mockResolvedValue(mixedFiles);

      const hook = render();
      // Reset throttle so retry can proceed
      setLastRetryAt(0);

      const result = await hook.retryAllInlineMic();

      // 2 inline-mic files attempted, voice-mode skipped
      expect(result.attempted).toBe(2);
      expect(mockVoiceApi.retryPendingAudio).toHaveBeenCalledTimes(2);
      expect(mockVoiceApi.retryPendingAudio).toHaveBeenCalledWith({ filePath: '/tmp/audio/im-1.webm' });
      expect(mockVoiceApi.retryPendingAudio).toHaveBeenCalledWith({ filePath: '/tmp/audio/im-2.webm' });
      // voice-mode file NOT retried
      expect(mockVoiceApi.retryPendingAudio).not.toHaveBeenCalledWith({ filePath: '/tmp/audio/vm-1.webm' });
    });

    it('returns zero counts when no inline-mic files', async () => {
      const voiceOnly = [
        { filePath: '/tmp/audio/vm-1.webm', createdAt: 1, source: 'voice-mode' as const },
      ];
      mockVoiceApi.getPendingAudio.mockResolvedValue(voiceOnly);

      const hook = render();
      setLastRetryAt(0);

      const result = await hook.retryAllInlineMic();

      expect(result.attempted).toBe(0);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(0);
      expect(mockVoiceApi.retryPendingAudio).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Global backoff
  // -------------------------------------------------------------------------
  describe('global backoff', () => {
    const twoInlineMicFiles = [
      { filePath: '/tmp/audio/im-1.webm', createdAt: 1, source: 'inline-mic' as const },
      { filePath: '/tmp/audio/im-2.webm', createdAt: 2, source: 'inline-mic' as const },
    ];

    it('doubles on full-batch failure', async () => {
      mockVoiceApi.getPendingAudio.mockResolvedValue(twoInlineMicFiles);
      mockVoiceApi.retryPendingAudio.mockResolvedValue({ success: false, error: 'Rate limited' });

      const hook = render();
      expect(getBackoffMs()).toBe(INITIAL_BACKOFF_MS); // 60_000

      setLastRetryAt(0);
      await hook.retryAllInlineMic();

      expect(getBackoffMs()).toBe(INITIAL_BACKOFF_MS * 2); // 120_000
    });

    it('doubles again on subsequent full-batch failure', async () => {
      mockVoiceApi.getPendingAudio.mockResolvedValue(twoInlineMicFiles);
      mockVoiceApi.retryPendingAudio.mockResolvedValue({ success: false, error: 'Rate limited' });

      const hook = render();
      setLastRetryAt(0);
      await hook.retryAllInlineMic();

      expect(getBackoffMs()).toBe(INITIAL_BACKOFF_MS * 2); // 120_000

      // Allow another retry (clear throttle)
      setLastRetryAt(0);
      refs[REF_IDX.isRetrying].current = false;
      await hook.retryAllInlineMic();

      expect(getBackoffMs()).toBe(INITIAL_BACKOFF_MS * 4); // 240_000
    });

    it('caps at MAX_BACKOFF_MS (10 minutes)', async () => {
      mockVoiceApi.getPendingAudio.mockResolvedValue(twoInlineMicFiles);
      mockVoiceApi.retryPendingAudio.mockResolvedValue({ success: false, error: 'fail' });

      const hook = render();
      // Set backoff close to max (after render populates refs)
      refs[REF_IDX.backoffMs].current = MAX_BACKOFF_MS / 2; // 300_000

      setLastRetryAt(0);
      await hook.retryAllInlineMic();

      // Would be 600_000, capped at MAX_BACKOFF_MS
      expect(getBackoffMs()).toBe(MAX_BACKOFF_MS);
    });

    it('resets on any success in the batch', async () => {
      mockVoiceApi.getPendingAudio.mockResolvedValue(twoInlineMicFiles);

      // First file fails, second succeeds
      mockVoiceApi.retryPendingAudio
        .mockResolvedValueOnce({ success: false, error: 'fail' })
        .mockResolvedValueOnce({ success: true, transcript: 'hello' });

      mockSessionStore();

      const hook = render();
      // Inflate backoff (after render populates refs)
      refs[REF_IDX.backoffMs].current = INITIAL_BACKOFF_MS * 4;

      setLastRetryAt(0);
      const result = await hook.retryAllInlineMic();

      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(1);
      // Backoff resets because at least one succeeded
      expect(getBackoffMs()).toBe(INITIAL_BACKOFF_MS);
    });

    it('does not change backoff when no files are attempted', async () => {
      mockVoiceApi.getPendingAudio.mockResolvedValue([]);

      const hook = render();
      const startBackoff = getBackoffMs();

      setLastRetryAt(0);
      await hook.retryAllInlineMic();

      expect(getBackoffMs()).toBe(startBackoff);
    });
  });

  // -------------------------------------------------------------------------
  // mergeState — stale entry pruning
  // -------------------------------------------------------------------------
  describe('mergeState (via refresh)', () => {
    it('prunes stale error entries for files no longer on disk', async () => {
      const file1 = { filePath: '/tmp/audio/a.webm', createdAt: 1, source: 'inline-mic' as const };
      const file2 = { filePath: '/tmp/audio/b.webm', createdAt: 2, source: 'inline-mic' as const };

      // Seed both files and add errors
      mockVoiceApi.getPendingAudio.mockResolvedValueOnce([file1, file2]);
      const hook = render();
      await hook.refresh();

      getErrorMap().set(file1.filePath, 'error-a');
      getErrorMap().set(file2.filePath, 'error-b');
      expect(getErrorMap().size).toBe(2);

      // Now file1 is gone — only file2 remains on disk
      mockVoiceApi.getPendingAudio.mockResolvedValueOnce([file2]);
      await hook.refresh();

      // file1's error should be pruned
      expect(getErrorMap().has(file1.filePath)).toBe(false);
      // file2's error should survive
      expect(getErrorMap().get(file2.filePath)).toBe('error-b');
    });

    it('prunes stale retrying-set entries', async () => {
      const file = { filePath: '/tmp/audio/a.webm', createdAt: 1, source: 'inline-mic' as const };

      mockVoiceApi.getPendingAudio.mockResolvedValueOnce([file]);
      const hook = render();
      await hook.refresh();

      // Manually mark as retrying
      const retryingSet = refs[REF_IDX.retryingSet].current as Set<string>;
      retryingSet.add(file.filePath);
      expect(retryingSet.size).toBe(1);

      // File removed from disk
      mockVoiceApi.getPendingAudio.mockResolvedValueOnce([]);
      await hook.refresh();

      expect(retryingSet.has(file.filePath)).toBe(false);
    });

    it('merges error state into returned file objects', async () => {
      const file = { filePath: '/tmp/audio/a.webm', createdAt: 1, source: 'inline-mic' as const };
      mockVoiceApi.getPendingAudio.mockResolvedValueOnce([file]);

      const hook = render();
      getErrorMap().set(file.filePath, 'API error');
      await hook.refresh();

      // Re-render to get updated files state
      const hook2 = render();
      const fileState = hook2.files.find(f => f.filePath === file.filePath);
      expect(fileState?.lastError).toBe('API error');
    });
  });

  // -------------------------------------------------------------------------
  // Throttle guard
  // -------------------------------------------------------------------------
  describe('retryAllInlineMic throttle', () => {
    it('prevents concurrent batch retries', async () => {
      const file = { filePath: '/tmp/audio/a.webm', createdAt: 1, source: 'inline-mic' as const };
      mockVoiceApi.getPendingAudio.mockResolvedValue([file]);
      mockVoiceApi.retryPendingAudio.mockResolvedValue({ success: false, error: 'fail' });

      const hook = render();
      setLastRetryAt(0);

      // Start two concurrent retries
      const [r1, r2] = await Promise.all([
        hook.retryAllInlineMic(),
        hook.retryAllInlineMic(),
      ]);

      // One should execute, the other should be a no-op
      const totalAttempted = r1.attempted + r2.attempted;
      expect(totalAttempted).toBe(1);
    });

    it('skips retry when called within MIN_RETRY_GAP_MS', async () => {
      const file = { filePath: '/tmp/audio/a.webm', createdAt: 1, source: 'inline-mic' as const };
      mockVoiceApi.getPendingAudio.mockResolvedValue([file]);
      mockVoiceApi.retryPendingAudio.mockResolvedValue({ success: false, error: 'fail' });

      const hook = render();
      // Set lastRetryAt to very recently (within MIN_RETRY_GAP_MS of 10_000)
      setLastRetryAt(Date.now() - 1_000);

      const result = await hook.retryAllInlineMic();
      expect(result.attempted).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // revealFile
  // -------------------------------------------------------------------------
  describe('revealFile', () => {
    it('calls revealPendingAudio IPC with the correct filePath', async () => {
      const hook = render();
      await hook.revealFile('/tmp/audio/recording-1.webm');

      expect(mockVoiceApi.revealPendingAudio).toHaveBeenCalledTimes(1);
      expect(mockVoiceApi.revealPendingAudio).toHaveBeenCalledWith({
        filePath: '/tmp/audio/recording-1.webm',
      });
    });

    it('propagates IPC errors (does not swallow)', async () => {
      mockVoiceApi.revealPendingAudio.mockRejectedValueOnce(new Error('File not found'));

      const hook = render();
      await expect(hook.revealFile('/tmp/audio/missing.webm')).rejects.toThrow('File not found');
    });
  });

  // -------------------------------------------------------------------------
  // Return value shape
  // -------------------------------------------------------------------------
  describe('return value', () => {
    it('returns expected API shape', () => {
      const hook = render();

      expect(typeof hook.retryFile).toBe('function');
      expect(typeof hook.revealFile).toBe('function');
      expect(typeof hook.dismissFile).toBe('function');
      expect(typeof hook.dismissAll).toBe('function');
      expect(typeof hook.retryAllInlineMic).toBe('function');
      expect(typeof hook.refresh).toBe('function');
      expect(Array.isArray(hook.files)).toBe(true);
      expect(typeof hook.pendingCount).toBe('number');
      expect(typeof hook.isRetrying).toBe('boolean');
    });

    it('pendingCount equals files.length', () => {
      const hook = render();
      expect(hook.pendingCount).toBe(hook.files.length);
    });
  });

  // -------------------------------------------------------------------------
  // errorCategory propagation
  // -------------------------------------------------------------------------
  describe('errorCategory', () => {
    const file = {
      filePath: '/tmp/audio/recording-1.webm',
      createdAt: Date.now() - 30_000,
      source: 'inline-mic' as const,
    };

    it('stores errorCategory from retry response on failure', async () => {
      mockVoiceApi.retryPendingAudio.mockResolvedValueOnce({
        success: false,
        error: 'Your voice provider account has run out of credits.',
        errorCategory: 'billing',
      });
      mockVoiceApi.getPendingAudio.mockResolvedValue([file]);

      const hook = await seedFiles([file]);
      await hook.retryFile(file.filePath);

      expect(getErrorCategoryMap().get(file.filePath)).toBe('billing');
    });

    it('stores errorCategory from batch retry on failure', async () => {
      mockVoiceApi.getPendingAudio.mockResolvedValue([file]);
      mockVoiceApi.retryPendingAudio.mockResolvedValueOnce({
        success: false,
        error: 'API key invalid',
        errorCategory: 'auth',
      });

      const hook = render();
      setLastRetryAt(0);
      await hook.retryAllInlineMic();

      expect(getErrorCategoryMap().get(file.filePath)).toBe('auth');
    });

    it('clears errorCategory on successful retry', async () => {
      mockSessionStore();
      mockVoiceApi.getPendingAudio.mockResolvedValue([file]);

      const hook = await seedFiles([file]);
      // Pre-set an error category
      getErrorCategoryMap().set(file.filePath, 'billing');

      mockVoiceApi.retryPendingAudio.mockResolvedValueOnce({
        success: true,
        transcript: 'Recovered text',
      });
      mockVoiceApi.getPendingAudio.mockResolvedValueOnce([]);

      await hook.retryFile(file.filePath);

      expect(getErrorCategoryMap().has(file.filePath)).toBe(false);
    });

    it('clears errorCategory on dismiss', async () => {
      const hook = render();
      getErrorCategoryMap().set(file.filePath, 'network');

      await hook.dismissFile(file.filePath);

      expect(getErrorCategoryMap().has(file.filePath)).toBe(false);
    });

    it('clears all errorCategories on dismissAll', async () => {
      const files = [
        { filePath: '/tmp/audio/a.webm', createdAt: 1, source: 'inline-mic' as const },
        { filePath: '/tmp/audio/b.webm', createdAt: 2, source: 'inline-mic' as const },
      ];
      mockVoiceApi.getPendingAudio.mockResolvedValue(files);
      const hook = await seedFiles(files);

      getErrorCategoryMap().set(files[0].filePath, 'billing');
      getErrorCategoryMap().set(files[1].filePath, 'auth');

      mockVoiceApi.getPendingAudio.mockResolvedValueOnce([]);
      await hook.dismissAll();

      expect(getErrorCategoryMap().size).toBe(0);
    });

    it('prunes stale errorCategory entries on refresh', async () => {
      const file1 = { filePath: '/tmp/audio/a.webm', createdAt: 1, source: 'inline-mic' as const };
      const file2 = { filePath: '/tmp/audio/b.webm', createdAt: 2, source: 'inline-mic' as const };

      mockVoiceApi.getPendingAudio.mockResolvedValueOnce([file1, file2]);
      const hook = render();
      await hook.refresh();

      getErrorCategoryMap().set(file1.filePath, 'billing');
      getErrorCategoryMap().set(file2.filePath, 'temporary');

      // file1 removed from disk
      mockVoiceApi.getPendingAudio.mockResolvedValueOnce([file2]);
      await hook.refresh();

      expect(getErrorCategoryMap().has(file1.filePath)).toBe(false);
      expect(getErrorCategoryMap().get(file2.filePath)).toBe('temporary');
    });

    it('merges errorCategory into file state via mergeState', async () => {
      mockVoiceApi.getPendingAudio.mockResolvedValueOnce([file]);
      const hook = render();
      getErrorCategoryMap().set(file.filePath, 'network');
      await hook.refresh();

      // Re-render to pick up state
      const hook2 = render();
      const fileState = hook2.files.find(f => f.filePath === file.filePath);
      expect(fileState?.errorCategory).toBe('network');
    });

    it('does not set errorCategory when retry response has no category', async () => {
      mockVoiceApi.retryPendingAudio.mockResolvedValueOnce({
        success: false,
        error: 'Unknown error',
      });
      mockVoiceApi.getPendingAudio.mockResolvedValue([file]);

      const hook = await seedFiles([file]);
      await hook.retryFile(file.filePath);

      expect(getErrorCategoryMap().has(file.filePath)).toBe(false);
    });
  });
});
