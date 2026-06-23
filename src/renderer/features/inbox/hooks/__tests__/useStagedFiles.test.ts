// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, flushAsync, createMockWindowApi } from '@renderer/test-utils';
import { useStagedFiles } from '../useStagedFiles';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

type AnyMock = ReturnType<typeof vi.fn>;

// Matches any lowercase v4 UUID (see Stage C assertions below). Kept as
// a module-level constant so every test that checks the `clientDedupKey`
// argument uses the same canonical shape.
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function setupWindowApis() {
  const mockApi = {
    getStagedFiles: vi.fn().mockResolvedValue({ files: [] }) as AnyMock,
    publishStagedFile: vi.fn() as AnyMock,
    discardStagedFile: vi.fn() as AnyMock,
    keepStagedFilePrivate: vi.fn() as AnyMock,
    publishAllStagedFiles: vi
      .fn()
      .mockResolvedValue({ published: [], conflicts: [], errors: [] }) as AnyMock,
    discardAllStagedFiles: vi.fn().mockResolvedValue({ success: true }) as AnyMock,
    publishWithConflictResolution: vi.fn() as AnyMock,
    // Stage B (260417_approval_consolidation_closeout): every resolve
    // call now mints a capability token first. Default mock returns a
    // well-shaped success envelope so existing tests keep passing.
    mintConflictCapability: vi.fn().mockResolvedValue({
      success: true,
      token: 'test.capability.token',
      expiresAt: Date.now() + 5 * 60 * 1000,
    }) as AnyMock,
    onStagedFilesChanged: vi.fn(() => () => undefined) as AnyMock,
  };

  const mockSessionsApi = {
    list: vi.fn().mockResolvedValue([]) as AnyMock,
  };

  createMockWindowApi('api', mockApi);
  createMockWindowApi('sessionsApi', mockSessionsApi);

  return { mockApi, mockSessionsApi };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useStagedFiles', () => {
  let apis: ReturnType<typeof setupWindowApis>;

  beforeEach(() => {
    vi.clearAllMocks();
    apis = setupWindowApis();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('publish — idempotent success (F3-4)', () => {
    it.each(['success', 'already-resolved', 'not-found'] as const)(
      'returns success and removes the file on status=%s',
      async (status) => {
        apis.mockApi.getStagedFiles.mockResolvedValue({
          files: [{
            id: 'a',
            realPath: '/ws/a.md',
            spaceName: 'Space',
            spacePath: 'space',
            sessionId: 's',
            baseHash: 'h',
            summary: '',
            stagedAt: 1,
            sensitivity: 'high' as const,
          }],
        });
        apis.mockApi.publishStagedFile.mockResolvedValue({ status });

        const { result } = renderHook(() => useStagedFiles());
        await flushAsync();
        expect(result.current.files).toHaveLength(1);

        let publishResult;
        await act(async () => {
          publishResult = await result.current.publish('a');
        });
        expect(publishResult).toEqual({ success: true });
        expect(result.current.files).toEqual([]);
        // Stage C (260417_approval_consolidation_closeout): hook now
        // attaches a per-action UUID dedup key. Match UUID shape rather
        // than an exact value so each test run stays deterministic.
        expect(apis.mockApi.publishStagedFile).toHaveBeenCalledWith(
          'a',
          expect.stringMatching(UUID_V4),
        );
      },
    );

    it('emits structured breadcrumb when status=already-resolved', async () => {
      apis.mockApi.publishStagedFile.mockResolvedValue({ status: 'already-resolved' });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const { result } = renderHook(() => useStagedFiles());
      await flushAsync();
      await act(async () => {
        await result.current.publish('xyz');
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('idempotent publish succeeded'),
        expect.objectContaining({ op: 'publish', id: 'xyz', status: 'already-resolved' }),
      );
      warnSpy.mockRestore();
    });

    it('does NOT emit breadcrumb on plain success', async () => {
      apis.mockApi.publishStagedFile.mockResolvedValue({ status: 'success' });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const { result } = renderHook(() => useStagedFiles());
      await flushAsync();
      await act(async () => {
        await result.current.publish('xyz');
      });
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('passes conflict payload through without removing the file', async () => {
      apis.mockApi.getStagedFiles.mockResolvedValue({
        files: [{
          id: 'a',
          realPath: '/ws/a.md',
          spaceName: 'Space',
          spacePath: 'space',
          sessionId: 's',
          baseHash: 'h',
          summary: '',
          stagedAt: 1,
          sensitivity: 'high' as const,
        }],
      });
      apis.mockApi.publishStagedFile.mockResolvedValue({
        status: 'conflict',
        conflict: { realContent: 'real', stagedContent: 'staged' },
      });

      const { result } = renderHook(() => useStagedFiles());
      await flushAsync();
      let publishResult;
      await act(async () => {
        publishResult = await result.current.publish('a');
      });
      expect(publishResult).toEqual({
        success: false,
        hasConflict: true,
        conflict: { realContent: 'real', stagedContent: 'staged' },
      });
      expect(result.current.files).toHaveLength(1);
    });

    it('surfaces an error without removing the file on non-terminal status', async () => {
      apis.mockApi.getStagedFiles.mockResolvedValue({
        files: [{
          id: 'a',
          realPath: '/ws/a.md',
          spaceName: 'Space',
          spacePath: 'space',
          sessionId: 's',
          baseHash: 'h',
          summary: '',
          stagedAt: 1,
          sensitivity: 'high' as const,
        }],
      });
      apis.mockApi.publishStagedFile.mockResolvedValue({ status: 'error', error: 'boom' });

      const { result } = renderHook(() => useStagedFiles());
      await flushAsync();
      let publishResult;
      await act(async () => {
        publishResult = await result.current.publish('a');
      });
      expect(publishResult).toEqual({ success: false, error: 'boom' });
      expect(result.current.files).toHaveLength(1);
    });

    it('classifies permission errors from rejected publish IPC calls', async () => {
      apis.mockApi.getStagedFiles.mockResolvedValue({
        files: [{
          id: 'a',
          realPath: '/ws/a.md',
          spaceName: 'Space',
          spacePath: 'space',
          sessionId: 's',
          baseHash: 'h',
          summary: '',
          stagedAt: 1,
          sensitivity: 'high' as const,
        }],
      });
      apis.mockApi.publishStagedFile.mockRejectedValue(new Error('EACCES: permission denied, open /ws/a.md'));

      const { result } = renderHook(() => useStagedFiles());
      await flushAsync();
      let publishResult;
      await act(async () => {
        publishResult = await result.current.publish('a');
      });
      expect(publishResult).toEqual({
        success: false,
        error: 'Permission denied or the file is read-only. Check access and try again.',
      });
      expect(result.current.files).toHaveLength(1);
    });
  });

  describe('discard — idempotent success (F3-4)', () => {
    it.each(['success', 'already-resolved', 'not-found'] as const)(
      'returns success and removes the file on status=%s',
      async (status) => {
        apis.mockApi.getStagedFiles.mockResolvedValue({
          files: [{
            id: 'x',
            realPath: '/ws/x.md',
            spaceName: 'Space',
            spacePath: 'space',
            sessionId: 's',
            baseHash: 'h',
            summary: '',
            stagedAt: 1,
            sensitivity: 'high' as const,
          }],
        });
        apis.mockApi.discardStagedFile.mockResolvedValue({ status });

        const { result } = renderHook(() => useStagedFiles());
        await flushAsync();
        let discardResult;
        await act(async () => {
          discardResult = await result.current.discard('x');
        });
        expect(discardResult).toEqual({ success: true });
        expect(result.current.files).toEqual([]);
      },
    );

    it('returns error without removing on non-terminal status', async () => {
      apis.mockApi.getStagedFiles.mockResolvedValue({
        files: [{
          id: 'x',
          realPath: '/ws/x.md',
          spaceName: 'Space',
          spacePath: 'space',
          sessionId: 's',
          baseHash: 'h',
          summary: '',
          stagedAt: 1,
          sensitivity: 'high' as const,
        }],
      });
      apis.mockApi.discardStagedFile.mockResolvedValue({ status: 'error', error: 'nope' });

      const { result } = renderHook(() => useStagedFiles());
      await flushAsync();
      let discardResult;
      await act(async () => {
        discardResult = await result.current.discard('x');
      });
      expect(discardResult).toEqual({ success: false, error: 'nope' });
      expect(result.current.files).toHaveLength(1);
    });
  });

  describe('keepPrivate — idempotent success (F3-4)', () => {
    it.each(['success', 'already-resolved', 'not-found'] as const)(
      'returns success and removes the file on status=%s',
      async (status) => {
        apis.mockApi.getStagedFiles.mockResolvedValue({
          files: [{
            id: 'k',
            realPath: '/ws/k.md',
            spaceName: 'Space',
            spacePath: 'space',
            sessionId: 's',
            baseHash: 'h',
            summary: '',
            stagedAt: 1,
            sensitivity: 'high' as const,
          }],
        });
        apis.mockApi.keepStagedFilePrivate.mockResolvedValue({
          status,
          destinationPath: '/ws/private.md',
        });

        const { result } = renderHook(() => useStagedFiles());
        await flushAsync();
        let kpResult;
        await act(async () => {
          kpResult = await result.current.keepPrivate('k');
        });
        expect(kpResult).toEqual({ success: true, destinationPath: '/ws/private.md' });
        expect(result.current.files).toEqual([]);
      },
    );

    it('returns error without removing on non-terminal status', async () => {
      apis.mockApi.getStagedFiles.mockResolvedValue({
        files: [{
          id: 'k',
          realPath: '/ws/k.md',
          spaceName: 'Space',
          spacePath: 'space',
          sessionId: 's',
          baseHash: 'h',
          summary: '',
          stagedAt: 1,
          sensitivity: 'high' as const,
        }],
      });
      apis.mockApi.keepStagedFilePrivate.mockResolvedValue({ status: 'error', error: 'denied' });

      const { result } = renderHook(() => useStagedFiles());
      await flushAsync();
      let kpResult;
      await act(async () => {
        kpResult = await result.current.keepPrivate('k');
      });
      expect(kpResult).toEqual({ success: false, error: 'denied' });
      expect(result.current.files).toHaveLength(1);
    });

    it('classifies storage errors returned by keep-private', async () => {
      apis.mockApi.getStagedFiles.mockResolvedValue({
        files: [{
          id: 'k',
          realPath: '/ws/k.md',
          spaceName: 'Space',
          spacePath: 'space',
          sessionId: 's',
          baseHash: 'h',
          summary: '',
          stagedAt: 1,
          sensitivity: 'high' as const,
        }],
      });
      apis.mockApi.keepStagedFilePrivate.mockResolvedValue({
        status: 'error',
        error: 'ENOSPC: no space left on device',
      });

      const { result } = renderHook(() => useStagedFiles());
      await flushAsync();
      let kpResult;
      await act(async () => {
        kpResult = await result.current.keepPrivate('k');
      });
      expect(kpResult).toEqual({
        success: false,
        error: 'Not enough storage is available. Free up space and try again.',
      });
      expect(result.current.files).toHaveLength(1);
    });
  });

  describe('resolveConflict — idempotent success (F3-4)', () => {
    it.each(['success', 'already-resolved', 'not-found'] as const)(
      'returns success and removes the file on status=%s',
      async (status) => {
        apis.mockApi.getStagedFiles.mockResolvedValue({
          files: [{
            id: 'c',
            realPath: '/ws/c.md',
            spaceName: 'Space',
            spacePath: 'space',
            sessionId: 's',
            baseHash: 'h',
            summary: '',
            stagedAt: 1,
            sensitivity: 'high' as const,
          }],
        });
        apis.mockApi.publishWithConflictResolution.mockResolvedValue({ status });

        const { result } = renderHook(() => useStagedFiles());
        await flushAsync();
        let rcResult;
        await act(async () => {
          rcResult = await result.current.resolveConflict('c', 'keep-staged');
        });
        expect(rcResult).toEqual({ success: true });
        expect(result.current.files).toEqual([]);
        // Stage B: handler signature now requires the minted token.
        // Stage C: hook also attaches a per-action UUID dedup key as
        // the 4th argument.
        expect(apis.mockApi.publishWithConflictResolution).toHaveBeenCalledWith(
          'c',
          'keep-staged',
          'test.capability.token',
          expect.stringMatching(UUID_V4),
        );
        expect(apis.mockApi.mintConflictCapability).toHaveBeenCalledWith('c');
      },
    );

    it('returns error without removing on non-terminal status', async () => {
      apis.mockApi.getStagedFiles.mockResolvedValue({
        files: [{
          id: 'c',
          realPath: '/ws/c.md',
          spaceName: 'Space',
          spacePath: 'space',
          sessionId: 's',
          baseHash: 'h',
          summary: '',
          stagedAt: 1,
          sensitivity: 'high' as const,
        }],
      });
      apis.mockApi.publishWithConflictResolution.mockResolvedValue({
        status: 'error',
        error: 'resolve-failed',
      });

      const { result } = renderHook(() => useStagedFiles());
      await flushAsync();
      let rcResult;
      await act(async () => {
        rcResult = await result.current.resolveConflict('c', 'keep-real');
      });
      expect(rcResult).toEqual({ success: false, error: 'resolve-failed' });
      expect(result.current.files).toHaveLength(1);
    });

    // Stage B (260417_approval_consolidation_closeout) — fail-closed when
    // the mint endpoint refuses. The hook must NOT reach the resolve
    // handler with an empty token, and must surface a clear error.
    it('fails closed when mint returns { success: false } (does NOT call resolve)', async () => {
      apis.mockApi.getStagedFiles.mockResolvedValue({
        files: [{
          id: 'c',
          realPath: '/ws/c.md',
          spaceName: 'Space',
          spacePath: 'space',
          sessionId: 's',
          baseHash: 'h',
          summary: '',
          stagedAt: 1,
          sensitivity: 'high' as const,
        }],
      });
      apis.mockApi.mintConflictCapability.mockResolvedValue({
        success: false,
        error: 'UNKNOWN_STAGED_FILE',
      });

      const { result } = renderHook(() => useStagedFiles());
      await flushAsync();
      let rcResult: { success: boolean; error?: string } | undefined;
      await act(async () => {
        rcResult = await result.current.resolveConflict('c', 'keep-staged');
      });
      expect(rcResult?.success).toBe(false);
      expect(rcResult?.error).toContain('UNKNOWN_STAGED_FILE');
      expect(apis.mockApi.publishWithConflictResolution).not.toHaveBeenCalled();
      expect(result.current.files).toHaveLength(1);
    });
  });

  describe('optimistic removal wiring (F3-1)', () => {
    it('publish fires notifyOptimisticRemoval for staged-file:*', async () => {
      apis.mockApi.getStagedFiles.mockResolvedValue({ files: [] });
      apis.mockApi.publishStagedFile.mockResolvedValue({ status: 'success' });

      const eventHandler = vi.fn();
      window.addEventListener('pending-approval-optimistic-removal', eventHandler);

      const { result } = renderHook(() => useStagedFiles());
      await flushAsync();
      await act(async () => {
        await result.current.publish('target-id');
      });

      expect(eventHandler).toHaveBeenCalled();
      window.removeEventListener('pending-approval-optimistic-removal', eventHandler);
    });

    it('keepPrivate fires notifyOptimisticRemoval for staged-file:*', async () => {
      apis.mockApi.getStagedFiles.mockResolvedValue({ files: [] });
      apis.mockApi.keepStagedFilePrivate.mockResolvedValue({ status: 'success' });

      const eventHandler = vi.fn();
      window.addEventListener('pending-approval-optimistic-removal', eventHandler);

      const { result } = renderHook(() => useStagedFiles());
      await flushAsync();
      await act(async () => {
        await result.current.keepPrivate('target-id-2');
      });

      expect(eventHandler).toHaveBeenCalled();
      window.removeEventListener('pending-approval-optimistic-removal', eventHandler);
    });
  });
});
