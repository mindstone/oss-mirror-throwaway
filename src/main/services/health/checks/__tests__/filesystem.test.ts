import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

// Mock electron app
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user-data'),
  },
}));

// Create hoisted mocks for fs functions
const mockStat = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockUnlink = vi.hoisted(() => vi.fn());
const mockMkdir = vi.hoisted(() => vi.fn());
const mockReaddir = vi.hoisted(() => vi.fn());
const mockStatfs = vi.hoisted(() => vi.fn());
const mockLstat = vi.hoisted(() => vi.fn());
const mockReadlink = vi.hoisted(() => vi.fn());
const mockAccess = vi.hoisted(() => vi.fn());

// Mock fs/promises module
vi.mock('node:fs/promises', () => ({
  default: {
    stat: mockStat,
    writeFile: mockWriteFile,
    readFile: mockReadFile,
    unlink: mockUnlink,
    mkdir: mockMkdir,
    readdir: mockReaddir,
    statfs: mockStatfs,
    lstat: mockLstat,
    readlink: mockReadlink,
    access: mockAccess,
  },
  stat: mockStat,
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  unlink: mockUnlink,
  mkdir: mockMkdir,
  readdir: mockReaddir,
  statfs: mockStatfs,
  lstat: mockLstat,
  readlink: mockReadlink,
  access: mockAccess,
}));

// Mock cloud storage utils
vi.mock('../../../../utils/cloudStorageUtils', () => ({
  detectCloudStorage: vi.fn(() => ({ isCloud: false, provider: null })),
  detectInPlaceCloudDocuments: vi.fn(() => false),
  getTimeoutForPath: vi.fn(() => 5000),
  FS_TIMEOUT_LOCAL_MS: 5000,
  FS_TIMEOUT_CLOUD_MS: 15000,
}));

// Mock the scoped logger so we can assert observable cleanup-skip logs (F1 round 3).
const mockLog = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLog,
}));

// Import after mocks are set up
import {
  checkWorkspaceAccessible,
  probeWorkspaceAccess,
  WORKSPACE_ACCESS_CHECK_TIMEOUT_MS,
  WORKSPACE_ACCESS_HEALTH_MAX_ATTEMPTS,
} from '../filesystem';
import type { AppSettings } from '@shared/types';
import type { CheckResult } from '../../types';

/**
 * Minimal re-implementation of `safeCheck`'s race semantics (see
 * `src/core/services/health/utils.ts`) — an AbortController aborted by a
 * setTimeout(timeoutMs), the check raced against an abort-rejection. Used to
 * prove the F1 no-false-critical invariant without pulling the diagnostics
 * ledger deps into this test.
 */
async function safeCheckLike(
  checkFn: (signal: AbortSignal) => Promise<CheckResult>,
  fallbackId: string,
  timeoutMs: number,
): Promise<CheckResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const timeoutPromise = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () =>
      reject(new Error(`Health check timed out after ${timeoutMs}ms`)),
    );
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => checkFn(controller.signal)),
      timeoutPromise,
    ]);
  } catch {
    return {
      id: fallbackId,
      name: fallbackId,
      status: 'fail',
      message: 'Check timed out',
      timedOut: true,
    } as CheckResult;
  } finally {
    clearTimeout(timeoutId);
  }
}

describe('probeWorkspaceAccess', () => {
  // Track the content written to probe files so we can return matching content
  let writtenContents: Map<string, string>;

  beforeEach(() => {
    vi.clearAllMocks();
    writtenContents = new Map();
    
    // Default: track writes and return matching content on reads
    mockWriteFile.mockImplementation(async (path: string, content: string) => {
      writtenContents.set(path, content);
      return undefined;
    });
    mockReadFile.mockImplementation(async (path: string) => {
      return writtenContents.get(path) ?? '';
    });
  });

  describe('successful probe scenarios', () => {
    it('should return accessible:true on successful probe', async () => {
      // Mock stat to return directory info
      mockStat.mockResolvedValue({ isDirectory: () => true });
      // Mock unlink to succeed (cleanup)
      mockUnlink.mockResolvedValue(undefined);

      const result = await probeWorkspaceAccess('/test/workspace');

      expect(result.accessible).toBe(true);
      expect(result.resolvedPath).toBe(path.resolve('/test/workspace'));
      expect(result.code).toBeUndefined();
      expect(result.error).toBeUndefined();
      
      // Verify the probe lifecycle was called
      expect(mockStat).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalled();
      expect(mockReadFile).toHaveBeenCalled();
      // Cleanup should be called
      expect(mockUnlink).toHaveBeenCalled();
    });

    it('should create directory when createIfMissing is true and directory does not exist', async () => {
      // First stat fails with ENOENT
      mockStat
        .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
        .mockResolvedValue({ isDirectory: () => true });
      // mkdir succeeds
      mockMkdir.mockResolvedValue(undefined);
      mockUnlink.mockResolvedValue(undefined);

      const result = await probeWorkspaceAccess('/test/new-workspace', { createIfMissing: true });

      expect(result.accessible).toBe(true);
      expect(result.created).toBe(true);
      expect(mockMkdir).toHaveBeenCalledWith(path.resolve('/test/new-workspace'), { recursive: true });
    });
  });

  describe('retry on transient DATA_MISMATCH error', () => {
    it('should retry and succeed on second attempt after DATA_MISMATCH', async () => {
      // Setup: stat always returns directory
      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockUnlink.mockResolvedValue(undefined);

      // First attempt: read returns mismatched content (DATA_MISMATCH)
      // Second attempt: read returns matching content
      let attemptCount = 0;
      mockReadFile.mockImplementation(async (path: string) => {
        attemptCount++;
        if (attemptCount === 1) {
          // First attempt: return mismatched content to trigger DATA_MISMATCH
          return 'corrupted-by-cloud-sync';
        }
        // Second attempt: return correct content
        return writtenContents.get(path) ?? '';
      });

      const result = await probeWorkspaceAccess('/test/workspace', {
        retry: { enabled: true, maxAttempts: 3 },
      });

      expect(result.accessible).toBe(true);
      expect(attemptCount).toBe(2); // Should have retried once
    });

    it('should log retry attempts with cloud provider info', async () => {
      // Mock cloud detection to return OneDrive
      const { detectCloudStorage } = await import('../../../../utils/cloudStorageUtils');
      vi.mocked(detectCloudStorage).mockReturnValue({ isCloud: true, provider: 'onedrive' });

      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockUnlink.mockResolvedValue(undefined);

      let attemptCount = 0;
      mockReadFile.mockImplementation(async (path: string) => {
        attemptCount++;
        if (attemptCount === 1) {
          return 'corrupted-by-cloud-sync';
        }
        return writtenContents.get(path) ?? '';
      });

      const result = await probeWorkspaceAccess('/test/onedrive/workspace', {
        retry: { enabled: true, maxAttempts: 3 },
      });

      expect(result.accessible).toBe(true);
      expect(attemptCount).toBe(2);
    });
  });

  describe('retry on EBUSY error', () => {
    it('should retry up to maxAttempts on EBUSY errors and succeed on third attempt', async () => {
      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockUnlink.mockResolvedValue(undefined);

      // First two writes fail with EBUSY, third succeeds
      let writeAttempts = 0;
      mockWriteFile.mockImplementation(async (path: string, content: string) => {
        writeAttempts++;
        if (writeAttempts <= 2) {
          throw Object.assign(new Error('Resource busy'), { code: 'EBUSY' });
        }
        writtenContents.set(path, content);
        return undefined;
      });

      const result = await probeWorkspaceAccess('/test/workspace', {
        retry: { enabled: true, maxAttempts: 3 },
      });

      expect(result.accessible).toBe(true);
      expect(writeAttempts).toBe(3); // Should have made 3 attempts
    });
  });

  describe('failure after max retries', () => {
    it('should return accessible:false with DATA_MISMATCH after all retries exhausted', async () => {
      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockUnlink.mockResolvedValue(undefined);

      // All attempts return mismatched content
      let attemptCount = 0;
      mockReadFile.mockImplementation(async () => {
        attemptCount++;
        return 'always-corrupted-content';
      });

      const result = await probeWorkspaceAccess('/test/workspace', {
        retry: { enabled: true, maxAttempts: 3 },
      });

      expect(result.accessible).toBe(false);
      expect(result.code).toBe('DATA_MISMATCH');
      expect(attemptCount).toBe(3); // Should have tried all 3 times
    });

    it('should include error message after max retries', async () => {
      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockUnlink.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('mismatched-content');

      const result = await probeWorkspaceAccess('/test/workspace', {
        retry: { enabled: true, maxAttempts: 3 },
      });

      expect(result.accessible).toBe(false);
      expect(result.error).toContain('data mismatch');
    });
  });

  describe('no retry when retry.enabled is false (default)', () => {
    it('should make only 1 attempt when retry is not enabled (default behavior)', async () => {
      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockUnlink.mockResolvedValue(undefined);

      let attemptCount = 0;
      mockReadFile.mockImplementation(async () => {
        attemptCount++;
        return 'corrupted-content'; // Will cause DATA_MISMATCH
      });

      // Default: no retry options (retry.enabled defaults to false)
      const result = await probeWorkspaceAccess('/test/workspace');

      expect(result.accessible).toBe(false);
      expect(result.code).toBe('DATA_MISMATCH');
      expect(attemptCount).toBe(1); // Only 1 attempt, no retry
    });

    it('should make only 1 attempt when retry is explicitly disabled', async () => {
      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockUnlink.mockResolvedValue(undefined);

      let attemptCount = 0;
      mockReadFile.mockImplementation(async () => {
        attemptCount++;
        return 'corrupted-content';
      });

      // Explicitly disable retry
      const result = await probeWorkspaceAccess('/test/workspace', {
        retry: { enabled: false },
      });

      expect(result.accessible).toBe(false);
      expect(result.code).toBe('DATA_MISMATCH');
      expect(attemptCount).toBe(1); // Only 1 attempt
    });
  });

  describe('non-retryable errors', () => {
    it('should not retry on ENOENT during stat (directory does not exist)', async () => {
      // ENOENT on stat without createIfMissing should not retry
      mockStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockUnlink.mockResolvedValue(undefined);

      const result = await probeWorkspaceAccess('/test/nonexistent', {
        retry: { enabled: true, maxAttempts: 3 },
      });

      expect(result.accessible).toBe(false);
      expect(result.code).toBe('ENOENT');
      expect(mockStat).toHaveBeenCalledTimes(1); // No retry
    });

    it('should not retry on ENOTDIR (path is not a directory)', async () => {
      mockStat.mockResolvedValue({ isDirectory: () => false });
      mockUnlink.mockResolvedValue(undefined);

      const result = await probeWorkspaceAccess('/test/file.txt', {
        retry: { enabled: true, maxAttempts: 3 },
      });

      expect(result.accessible).toBe(false);
      expect(result.code).toBe('ENOTDIR');
      expect(mockStat).toHaveBeenCalledTimes(1);
    });

    it('should not retry on EACCES (permission denied)', async () => {
      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockWriteFile.mockRejectedValue(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));
      mockUnlink.mockResolvedValue(undefined);

      const result = await probeWorkspaceAccess('/test/protected', {
        retry: { enabled: true, maxAttempts: 3 },
      });

      expect(result.accessible).toBe(false);
      expect(result.code).toBe('EACCES');
      // Only 1 write attempt - EACCES is not retryable
      expect(mockWriteFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('ENOENT on read (retryable)', () => {
    it('should retry when ENOENT occurs during read (file deleted by sync)', async () => {
      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockUnlink.mockResolvedValue(undefined);

      // First read: ENOENT (file deleted by cloud sync)
      // Second read: success
      let readAttempts = 0;
      mockReadFile.mockImplementation(async (path: string) => {
        readAttempts++;
        if (readAttempts === 1) {
          // Throw ENOENT - the error message from probeWorkspaceAccessSingle
          // includes "read" which makes ENOENT retryable
          const err = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
          throw err;
        }
        return writtenContents.get(path) ?? '';
      });

      const result = await probeWorkspaceAccess('/test/workspace', {
        retry: { enabled: true, maxAttempts: 3 },
      });

      expect(result.accessible).toBe(true);
      expect(readAttempts).toBe(2);
    });
  });

  describe('exponential backoff timing', () => {
    it('should apply delays between retries', async () => {
      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockUnlink.mockResolvedValue(undefined);

      const attemptTimes: number[] = [];
      let attemptCount = 0;
      mockReadFile.mockImplementation(async (path: string) => {
        attemptTimes.push(Date.now());
        attemptCount++;
        if (attemptCount < 3) {
          return 'mismatched';
        }
        return writtenContents.get(path) ?? '';
      });

      const result = await probeWorkspaceAccess('/test/workspace', {
        retry: { enabled: true, maxAttempts: 3 },
      });

      expect(result.accessible).toBe(true);
      expect(attemptTimes.length).toBe(3);

      // Verify there are delays between attempts.
      // First delay should be ~500ms, second should be ~1000ms.
      // Allow some margin for test execution time (~25%).
      const delay1 = attemptTimes[1]! - attemptTimes[0]!;
      const delay2 = attemptTimes[2]! - attemptTimes[1]!;

      expect(delay1).toBeGreaterThanOrEqual(375); // Expected ~500ms
      expect(delay2).toBeGreaterThanOrEqual(750); // Expected ~1000ms
    });
  });

  describe('retry on ETIMEDOUT (event-loop saturation / slow filesystem)', () => {
    it('should retry when stat times out and succeed when the queue drains', async () => {
      mockUnlink.mockResolvedValue(undefined);

      // First stat: simulate withTimeout firing (the prober normalizes any
      // "timed out" message to code: 'ETIMEDOUT'). Second stat: succeeds.
      let statAttempts = 0;
      mockStat.mockImplementation(async () => {
        statAttempts++;
        if (statAttempts === 1) {
          throw new Error("Operation 'stat' timed out after 5000ms");
        }
        return { isDirectory: () => true };
      });

      const result = await probeWorkspaceAccess('/test/workspace', {
        retry: { enabled: true, maxAttempts: 3 },
      });

      expect(result.accessible).toBe(true);
      expect(statAttempts).toBe(2);
    });

    it('should retry when write times out and succeed on second attempt', async () => {
      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockUnlink.mockResolvedValue(undefined);

      let writeAttempts = 0;
      mockWriteFile.mockImplementation(async (probePath: string, content: string) => {
        writeAttempts++;
        if (writeAttempts === 1) {
          throw new Error("Operation 'writeFile' timed out after 5000ms");
        }
        writtenContents.set(probePath, content);
        return undefined;
      });

      const result = await probeWorkspaceAccess('/test/workspace', {
        retry: { enabled: true, maxAttempts: 3 },
      });

      expect(result.accessible).toBe(true);
      expect(writeAttempts).toBe(2);
    });

    it('should return ETIMEDOUT after max retries when timeouts persist', async () => {
      mockUnlink.mockResolvedValue(undefined);

      mockStat.mockImplementation(async () => {
        throw new Error("Operation 'stat' timed out after 5000ms");
      });

      const result = await probeWorkspaceAccess('/test/workspace', {
        retry: { enabled: true, maxAttempts: 3 },
      });

      expect(result.accessible).toBe(false);
      expect(result.code).toBe('ETIMEDOUT');
      expect(mockStat).toHaveBeenCalledTimes(3);
    });

    it('should normalize mkdir timeout to ETIMEDOUT and retry (createIfMissing path)', async () => {
      mockUnlink.mockResolvedValue(undefined);

      // stat keeps returning ENOENT until after mkdir succeeds, then returns directory.
      let statCalls = 0;
      mockStat.mockImplementation(async () => {
        statCalls++;
        // Calls 1 and 2 are pre-mkdir on attempts 1 and 2 (both ENOENT).
        // Call 3 is the re-stat after attempt 2's mkdir succeeds.
        if (statCalls < 3) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return { isDirectory: () => true };
      });

      // First mkdir times out (now normalized to ETIMEDOUT and retryable).
      // Second mkdir succeeds.
      let mkdirAttempts = 0;
      mockMkdir.mockImplementation(async () => {
        mkdirAttempts++;
        if (mkdirAttempts === 1) {
          throw new Error("Operation 'mkdir' timed out after 5000ms");
        }
        return undefined;
      });

      const result = await probeWorkspaceAccess('/test/new-workspace', {
        createIfMissing: true,
        retry: { enabled: true, maxAttempts: 3 },
      });

      expect(result.accessible).toBe(true);
      expect(result.created).toBe(true);
      expect(mkdirAttempts).toBe(2);
    });
  });

  describe('cleanup', () => {
    it('should cleanup all probe files after successful probe', async () => {
      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockUnlink.mockResolvedValue(undefined);

      await probeWorkspaceAccess('/test/workspace');

      // Verify unlink was called for cleanup
      expect(mockUnlink).toHaveBeenCalled();
      // The probe file path should contain the unique pattern
      const unlinkCall = mockUnlink.mock.calls[0]?.[0] as string;
      expect(unlinkCall).toContain('.mindstonerebel-probe-');
      expect(unlinkCall).toContain('.tmp');
    });

    it('should cleanup all probe files after failed retries', async () => {
      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockReadFile.mockResolvedValue('mismatched');
      mockUnlink.mockResolvedValue(undefined);

      const result = await probeWorkspaceAccess('/test/workspace', {
        retry: { enabled: true, maxAttempts: 3 },
      });
      expect(result.accessible).toBe(false);

      // Each of the 3 attempts cleans up its probe file in a finally block.
      // Since successful cleanup removes the path from the cross-attempt list,
      // the final cleanup pass should be a no-op. Total: 3 calls.
      expect(mockUnlink).toHaveBeenCalledTimes(3);
    });

    it('should handle cleanup errors gracefully (non-fatal)', async () => {
      mockStat.mockResolvedValue({ isDirectory: () => true });
      // Cleanup fails - should not affect result
      mockUnlink.mockRejectedValue(new Error('Cleanup failed'));

      const result = await probeWorkspaceAccess('/test/workspace');

      // Should still succeed - cleanup failure is non-fatal
      expect(result.accessible).toBe(true);
    });
  });

  // 2b — empirical ETIMEDOUT timeout escalation (path-agnostic, dir exists)
  describe('ETIMEDOUT timeout escalation (Bug A defense-in-depth)', () => {
    it('escalation is budget-dependent: a 10s write fails at the 5s local budget but succeeds once escalated to the 15s cloud budget (fake timers)', async () => {
      // F3: this test FAILS if the escalation block is deleted, because the
      // write deterministically takes 10s — longer than the 5s local budget
      // (attempt 1 times out) but shorter than the escalated 15s cloud budget
      // (attempt 2 completes). Without escalation, attempt 2 would also run at 5s
      // and time out → the probe would fail.
      vi.useFakeTimers();
      try {
        const { getTimeoutForPath } = await import('../../../../utils/cloudStorageUtils');
        vi.mocked(getTimeoutForPath).mockReturnValue(5000); // local base budget

        mockStat.mockResolvedValue({ isDirectory: () => true });
        mockUnlink.mockResolvedValue(undefined);

        // Each write resolves 10s after it is invoked (real wall-clock modelled
        // via fake timers). withTimeout races it against the per-attempt budget.
        mockWriteFile.mockImplementation(
          (probePath: string, content: string | { encoding: string }) =>
            new Promise((resolve) => {
              setTimeout(() => {
                const value = typeof content === 'string' ? content : 'workspace-probe';
                writtenContents.set(probePath, value);
                resolve(undefined);
              }, 10_000);
            }),
        );
        // read returns whatever was written so content matches → accessible.
        mockReadFile.mockImplementation(async (probePath: string) =>
          writtenContents.get(probePath) ?? 'workspace-probe',
        );
        // make written content match what readFile returns
        writtenContents.clear();

        const promise = probeWorkspaceAccess('/test/slow-workspace', {
          retry: { enabled: true, maxAttempts: 2 },
        });

        // Attempt 1: advance past the 5s local budget → withTimeout fires → ETIMEDOUT.
        await vi.advanceTimersByTimeAsync(5_000);
        // Backoff (500ms) then attempt 2 begins at the escalated 15s budget.
        await vi.advanceTimersByTimeAsync(500);
        // Advance 10s: the write completes (10s < 15s escalated budget) → success.
        await vi.advanceTimersByTimeAsync(10_000);

        const result = await promise;
        expect(result.accessible).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('marks statSucceeded on an ETIMEDOUT during write (dir existed)', async () => {
      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockUnlink.mockResolvedValue(undefined);
      mockWriteFile.mockImplementation(async () => {
        throw new Error("Operation 'writeFile' timed out after 5000ms");
      });

      const result = await probeWorkspaceAccess('/test/slow-workspace', {
        retry: { enabled: true, maxAttempts: 1 },
      });

      expect(result.accessible).toBe(false);
      expect(result.code).toBe('ETIMEDOUT');
      expect(result.statSucceeded).toBe(true);
    });

    it('does NOT set statSucceeded when the stat itself timed out (path unreachable)', async () => {
      mockUnlink.mockResolvedValue(undefined);
      mockStat.mockImplementation(async () => {
        throw new Error("Operation 'stat' timed out after 5000ms");
      });

      const result = await probeWorkspaceAccess('/test/unreachable', {
        retry: { enabled: true, maxAttempts: 1 },
      });

      expect(result.accessible).toBe(false);
      expect(result.code).toBe('ETIMEDOUT');
      expect(result.statSucceeded).toBeFalsy();
    });
  });

  // F1 round 2 — a single per-ATTEMPT deadline bounds the whole multi-op attempt
  describe('per-attempt deadline (F1 round 2 — multi-op attempt bounded by timeoutMs)', () => {
    it('a 4s stat THEN a 4s write does NOT sum to 8s: the attempt times out at its 5s deadline (fake timers)', async () => {
      // This test FAILS on revert (if each op gets the FULL timeoutMs again):
      // with per-op budgets, stat(4s)+write(4s) both fit in their own 5s windows
      // and the probe SUCCEEDS at ~8s wall-clock. With ONE per-attempt deadline,
      // stat consumes 4s of the 5s, write gets only ~1s remaining → times out, and
      // the whole attempt ends at the 5s deadline with ETIMEDOUT.
      vi.useFakeTimers();
      try {
        const { getTimeoutForPath } = await import('../../../../utils/cloudStorageUtils');
        vi.mocked(getTimeoutForPath).mockReturnValue(5000);

        // stat resolves 4s after invocation.
        mockStat.mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ isDirectory: () => true }), 4000);
            }),
        );
        // write resolves 4s after invocation (would succeed if given a full 5s).
        const written = new Map<string, string>();
        mockWriteFile.mockImplementation(
          (probePath: string, content: string) =>
            new Promise((resolve) => {
              setTimeout(() => {
                written.set(probePath, content);
                resolve(undefined);
              }, 4000);
            }),
        );
        mockReadFile.mockImplementation(async (probePath: string) => written.get(probePath) ?? '');
        mockUnlink.mockResolvedValue(undefined);

        let settled = false;
        const promise = probeWorkspaceAccess('/test/slow-multi-op', {
          retry: { enabled: false }, // single attempt — isolate the per-attempt bound
        }).then((r) => {
          settled = true;
          return r;
        });

        // Advance the 4s stat.
        await vi.advanceTimersByTimeAsync(4000);
        // The write now has only ~1s of the 5s attempt deadline left.
        await vi.advanceTimersByTimeAsync(1000);
        // At the 5s deadline the attempt must already be settled to ETIMEDOUT.
        // (Under the reverted per-op behaviour, the write would still be pending
        // until 8s and `settled` would be false here.)
        expect(settled).toBe(true);

        const result = await promise;
        expect(result.accessible).toBe(false);
        expect(result.code).toBe('ETIMEDOUT');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // F1 round 3 — ONE overall deadline bounds the WHOLE health call, incl. cleanup
  describe('overall whole-call budget (F1 round 3 — cleanup cannot run past budget)', () => {
    it('a health attempt that nearly spends the budget + a SLOW leftover cleanup still settles within the overall budget (fake timers)', async () => {
      // FAIL-ON-REVERT: if the loop-level cleanupProbeFiles uses the FULL timeoutMs
      // (15s) per leftover file, the slow 5s unlink runs ~14s + 5s = ~19s,
      // exceeding the 18s safeCheck wrapper → wrapper wins → false fail. With the
      // overall budget + budget-aware cleanup, the whole call settles within
      // WORKSPACE_HEALTH_OVERALL_BUDGET_MS (17s) and the wrapper never fires.
      vi.useFakeTimers();
      try {
        const { getTimeoutForPath } = await import('../../../../utils/cloudStorageUtils');
        vi.mocked(getTimeoutForPath).mockReturnValue(15000); // cloud budget

        mockStat.mockResolvedValue({ isDirectory: () => true });
        // write times out at ~14s (statSucceeded; terminal in health) → the probe
        // file stays tracked for the loop-level cleanup, and ~3s of the 17s overall
        // budget remains.
        mockWriteFile.mockImplementation(
          () =>
            new Promise((_resolve, reject) => {
              setTimeout(() => reject(new Error("Operation 'writeFile' timed out after 14000ms")), 14000);
            }),
        );
        // leftover cleanup unlink is SLOW (would take 5s if unbounded).
        mockUnlink.mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve(undefined), 5000);
            }),
        );

        let probeSettledAt = -1;
        const start = Date.now();
        const wrapperPromise = safeCheckLike(
          () =>
            probeWorkspaceAccess('/test/slow-cleanup', {
              retry: { enabled: true, maxAttempts: 2 },
              retryOnTimeout: false, // HEALTH path → overall budget applies
            }).then(() => {
              probeSettledAt = Date.now() - start;
              return { id: 'workspaceAccessible', name: 'ws', status: 'fail' } as CheckResult;
            }),
          'workspaceAccessible',
          WORKSPACE_ACCESS_CHECK_TIMEOUT_MS, // 18s wrapper
        );

        // Advance to the overall budget ceiling (17s) plus a margin.
        await vi.advanceTimersByTimeAsync(17_500);

        const result = await wrapperPromise;
        // The probe must have settled on its OWN (within the overall budget),
        // never via the wrapper timeout fallback.
        expect(probeSettledAt).toBeGreaterThanOrEqual(0);
        expect(probeSettledAt).toBeLessThanOrEqual(18_000);
        expect(result.timedOut).toBeFalsy();
      } finally {
        vi.useRealTimers();
      }
    });

    it('skips leftover cleanup with an OBSERVABLE log when the overall budget is spent', async () => {
      // Drive the attempt to consume the WHOLE overall budget (timeoutMs == overall
      // budget) so the final cleanup has zero remaining → it must SKIP and log
      // (not silently swallow, and not schedule a slow unlink past the deadline).
      vi.useFakeTimers();
      try {
        mockLog.debug.mockClear();
        mockStat.mockResolvedValue({ isDirectory: () => true });
        // write hangs until its per-attempt deadline (== overall deadline here).
        mockWriteFile.mockImplementation(
          () => new Promise(() => { /* never resolves; raced by the deadline */ }),
        );
        // If cleanup were ever invoked it would resolve, but it must be SKIPPED.
        mockUnlink.mockResolvedValue(undefined);

        const promise = probeWorkspaceAccess('/test/budget-spent', {
          retry: { enabled: false },
          retryOnTimeout: false,          // HEALTH path → overall budget applies
          timeoutMs: 17000,               // == WORKSPACE_HEALTH_OVERALL_BUDGET_MS
        });

        // Advance to the overall deadline: write times out, and the final cleanup
        // finds zero remaining overall budget → skip + observable log.
        await vi.advanceTimersByTimeAsync(17000);

        const result = await promise;
        expect(result.code).toBe('ETIMEDOUT');
        // The leftover write probe file was tracked but never unlinked...
        expect(mockUnlink).not.toHaveBeenCalled();
        // ...and the skip was logged observably (not silently swallowed).
        const skipLogged = mockLog.debug.mock.calls.some(
          ([, msg]) => typeof msg === 'string' && msg.includes('cleanup skipped'),
        );
        expect(skipLogged).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('FOREGROUND leftover cleanup keeps the full timeoutMs budget, not the 2s health cap (F1 round 4 / F2 regression fix)', async () => {
      // Foreground path (retryOnTimeout default true → overallDeadlineAt undefined).
      // A leftover probe file reaches the loop-level cleanupProbeFiles, whose unlink
      // takes 3s. With the foreground timeoutMs budget (5s) that 3s unlink COMPLETES
      // and the whole probe only settles after it (~3s). FAIL-ON-REVERT: if cleanup
      // wrongly used the 2s health cap (the rev3 regression), the unlink would time
      // out at 2s and the probe would settle at ~2s — so at the 2.5s mark it would
      // already be settled.
      vi.useFakeTimers();
      try {
        const { getTimeoutForPath } = await import('../../../../utils/cloudStorageUtils');
        vi.mocked(getTimeoutForPath).mockReturnValue(5000); // foreground local budget

        mockStat.mockResolvedValue({ isDirectory: () => true });
        // write fails non-retryable (EACCES) → file is tracked; we reach loop cleanup.
        mockWriteFile.mockRejectedValue(
          Object.assign(new Error('Permission denied'), { code: 'EACCES' }),
        );
        // First unlink (inner finally) rejects fast so the path stays tracked for
        // the loop-level cleanup; the second unlink (loop-level) is SLOW (3s).
        let unlinkCalls = 0;
        mockUnlink.mockImplementation(
          () =>
            new Promise((resolve, reject) => {
              unlinkCalls++;
              if (unlinkCalls === 1) {
                reject(Object.assign(new Error('busy'), { code: 'EBUSY' }));
                return;
              }
              setTimeout(() => resolve(undefined), 3000);
            }),
        );

        let settled = false;
        const promise = probeWorkspaceAccess('/test/foreground-cleanup', {
          retry: { enabled: true, maxAttempts: 1 },
          // retryOnTimeout defaults true → FOREGROUND semantics, no overall budget.
        }).then((r) => {
          settled = true;
          return r;
        });

        // At 2.5s the foreground loop-level unlink (3s, 5s budget) is still pending,
        // so the probe must NOT be settled yet. (Under the 2s-cap regression it
        // would have timed out at 2s and already be settled.)
        await vi.advanceTimersByTimeAsync(2500);
        expect(settled).toBe(false);

        // After the 3s unlink completes, the probe settles.
        await vi.advanceTimersByTimeAsync(1000);
        expect(settled).toBe(true);
        const result = await promise;
        expect(result.code).toBe('EACCES');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // 2a — abort signal threading: abandoned retries must stop, no fs work after abort
  describe('abort signal (Bug C — no abandoned background retries)', () => {
    it('stops before starting a new attempt once the signal aborts (no further fs work)', async () => {
      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockUnlink.mockResolvedValue(undefined);

      const controller = new AbortController();

      // Attempt-1 write times out → would normally retry. We abort during the
      // backoff so attempt-2 must NOT run.
      let writeAttempts = 0;
      mockWriteFile.mockImplementation(async () => {
        writeAttempts++;
        // Abort right after the first failing write is observed.
        controller.abort();
        throw new Error("Operation 'writeFile' timed out after 5000ms");
      });

      const result = await probeWorkspaceAccess('/test/workspace', {
        retry: { enabled: true, maxAttempts: 3 },
        signal: controller.signal,
      });

      expect(result.accessible).toBe(false);
      expect(result.code).toBe('ETIMEDOUT');
      // CRITICAL: only ONE write attempt — the retry was abandoned on abort,
      // so no background fs work runs after the check settles.
      expect(writeAttempts).toBe(1);
    });

    it('returns a timeout result immediately if already aborted before the first attempt', async () => {
      mockStat.mockResolvedValue({ isDirectory: () => true });
      const controller = new AbortController();
      controller.abort();

      const result = await probeWorkspaceAccess('/test/workspace', {
        retry: { enabled: true, maxAttempts: 3 },
        signal: controller.signal,
      });

      expect(result.accessible).toBe(false);
      expect(result.code).toBe('ETIMEDOUT');
      // No fs probe op started at all.
      expect(mockStat).not.toHaveBeenCalled();
    });

    it('abort WHILE a write is pending schedules NO new fs work afterward (F3/F2)', async () => {
      // The hard case: abort fires while an fs op is in flight. Assert that after
      // the probe settles, no further fs calls were scheduled (read/write/unlink
      // call counts do not grow), proving the thunk guard + race stop new work.
      const controller = new AbortController();

      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockUnlink.mockResolvedValue(undefined);

      // writeFile never resolves on its own; it aborts mid-flight. The native
      // {signal} would reject in production; here we simulate by rejecting with an
      // AbortError once the controller fires.
      mockWriteFile.mockImplementation(
        (_probePath: string, _content: unknown) =>
          new Promise((_resolve, reject) => {
            controller.signal.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR', name: 'AbortError' })),
              { once: true },
            );
          }),
      );

      const promise = probeWorkspaceAccess('/test/workspace', {
        retry: { enabled: true, maxAttempts: 3 },
        signal: controller.signal,
      });

      // Let attempt-1's write get scheduled (stat → write across several
      // microtasks), then abort while the write is pending.
      await new Promise((r) => setTimeout(r, 10));
      expect(mockWriteFile).toHaveBeenCalledTimes(1); // write is in flight
      controller.abort();

      const result = await promise;

      // Capture call counts AFTER settlement, then wait a tick and assert no growth.
      const statCalls = mockStat.mock.calls.length;
      const writeCalls = mockWriteFile.mock.calls.length;
      const readCalls = mockReadFile.mock.calls.length;
      await new Promise((r) => setTimeout(r, 20));

      expect(result.accessible).toBe(false);
      expect(result.code).toBe('ETIMEDOUT');
      // Exactly one write was attempted; no retry write after abort.
      expect(writeCalls).toBe(1);
      // The write aborted, so its probe file is still tracked. The F2 guard means
      // BOTH the inner finally-cleanup AND the loop's cleanup pass see the aborted
      // signal and skip scheduling fs.unlink entirely. (With the pre-fix
      // eager-evaluation, fs.unlink WOULD have been scheduled during cleanup.)
      expect(mockUnlink).not.toHaveBeenCalled();
      // No NEW fs work scheduled after settlement either.
      expect(mockStat.mock.calls.length).toBe(statCalls);
      expect(mockWriteFile.mock.calls.length).toBe(writeCalls);
      expect(mockReadFile.mock.calls.length).toBe(readCalls);
    });
  });
});

// 2d — honest, provider-agnostic remediation copy
describe('checkWorkspaceAccessible remediation copy (Bug A §1d)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // A prior test sets detectCloudStorage → OneDrive via mockReturnValue, which
    // clearAllMocks does NOT reset. Restore the local-path default so these
    // remediation tests exercise the non-cloud honest-copy branch.
    const { detectCloudStorage, detectInPlaceCloudDocuments } = await import(
      '../../../../utils/cloudStorageUtils'
    );
    vi.mocked(detectCloudStorage).mockReturnValue({ isCloud: false });
    vi.mocked(detectInPlaceCloudDocuments).mockReturnValue(false);
  });

  const SETTINGS = { coreDirectory: '/Users/arthur/Documents/Mindstone Rebel' } as AppSettings;

  it('does NOT say "network drive" when the dir exists but write timed out (existing-dir + ETIMEDOUT)', async () => {
    // stat succeeds (dir exists), every write times out → ETIMEDOUT with
    // statSucceeded true after the bounded retry budget.
    mockStat.mockResolvedValue({ isDirectory: () => true });
    mockUnlink.mockResolvedValue(undefined);
    mockWriteFile.mockImplementation(async () => {
      throw new Error("Operation 'writeFile' timed out after 5000ms");
    });

    const result = await checkWorkspaceAccessible(SETTINGS);

    expect(result.status).toBe('fail');
    expect(result.remediation).not.toMatch(/network drive/i);
    expect(result.remediation).toMatch(/syncing or temporarily offline/i);
  });

  it('still says "network drive" when the path is genuinely unreachable (stat timed out)', async () => {
    // stat itself times out → statSucceeded false → reserve the network-drive copy.
    mockUnlink.mockResolvedValue(undefined);
    mockStat.mockImplementation(async () => {
      throw new Error("Operation 'stat' timed out after 5000ms");
    });

    const result = await checkWorkspaceAccessible(SETTINGS);

    expect(result.status).toBe('fail');
    expect(result.remediation).toMatch(/network drive/i);
  });

  it('does NOT retry a timeout in the health path (retryOnTimeout:false → ETIMEDOUT is terminal at 1 attempt)', async () => {
    mockUnlink.mockResolvedValue(undefined);
    // Persistent stat timeout. In the health path a timeout is the slow/unreachable
    // case, terminal at the detection-informed budget — so exactly ONE stat,
    // never a second full attempt (the F1 invariant: keeps worst-case ≤ wrapper).
    mockStat.mockImplementation(async () => {
      throw new Error("Operation 'stat' timed out after 5000ms");
    });

    await checkWorkspaceAccessible(SETTINGS);

    expect(mockStat).toHaveBeenCalledTimes(1);
  });

  it('still retries a QUICK transient in the health path up to the bounded budget', async () => {
    // stat succeeds; a transient DATA_MISMATCH on read clears on the 2nd attempt.
    // Quick transients ARE retried (sub-second) even with retryOnTimeout:false.
    mockStat.mockResolvedValue({ isDirectory: () => true });
    mockUnlink.mockResolvedValue(undefined);
    const written = new Map<string, string>();
    mockWriteFile.mockImplementation(async (probePath: string, content: string) => {
      written.set(probePath, content);
      return undefined;
    });
    let reads = 0;
    mockReadFile.mockImplementation(async (probePath: string) => {
      reads++;
      return reads === 1 ? 'corrupted-by-sync' : (written.get(probePath) ?? '');
    });

    const result = await checkWorkspaceAccessible(SETTINGS);

    expect(result.status).toBe('pass');
    expect(reads).toBe(2); // retried once within the bounded budget
    expect(WORKSPACE_ACCESS_HEALTH_MAX_ATTEMPTS).toBe(2);
    expect(WORKSPACE_ACCESS_HEALTH_MAX_ATTEMPTS).toBeLessThan(3);
  });

  it('no false-critical: a workspace that succeeds at ~14s on the cloud budget resolves accessible under the wrapper (fake timers)', async () => {
    // F1/F3: model a slow-hydrating workspace whose write completes at 14s — under
    // both the 15s cloud per-op budget AND the 18s safeCheck wrapper. The check
    // must resolve `pass` (NOT a timeout-fail that would escalate to critical).
    vi.useFakeTimers();
    try {
      const { getTimeoutForPath, detectCloudStorage, detectInPlaceCloudDocuments } =
        await import('../../../../utils/cloudStorageUtils');
      // Treat as in-place iCloud → 15s cloud budget on the first probe.
      vi.mocked(getTimeoutForPath).mockReturnValue(15000);
      vi.mocked(detectCloudStorage).mockReturnValue({ isCloud: false });
      vi.mocked(detectInPlaceCloudDocuments).mockReturnValue(true);

      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockUnlink.mockResolvedValue(undefined);
      const written = new Map<string, string>();
      // Write completes 14s after invocation (< 15s budget, < 18s wrapper).
      mockWriteFile.mockImplementation(
        (probePath: string, content: string) =>
          new Promise((resolve) => {
            setTimeout(() => {
              written.set(probePath, content);
              resolve(undefined);
            }, 14000);
          }),
      );
      mockReadFile.mockImplementation(async (probePath: string) => written.get(probePath) ?? '');

      const promise = safeCheckLike(
        (signal) => checkWorkspaceAccessible(SETTINGS, signal),
        'workspaceAccessible',
        WORKSPACE_ACCESS_CHECK_TIMEOUT_MS,
      );

      // Advance to 14s: the write completes before the 15s op budget and the 18s
      // wrapper, so the probe succeeds.
      await vi.advanceTimersByTimeAsync(14000);

      const result = await promise;
      expect(result.status).toBe('pass');
      expect(result.timedOut).toBeFalsy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('known-cloud remediation does NOT invoke a (potentially cold) in-place xattr detector post-probe (F1 round 4)', async () => {
    // On a KNOWN-cloud path, getTimeoutForPath short-circuits before ever
    // calling/caching detectInPlaceCloudDocuments, so a cold xattr in the
    // remediation would land AFTER the ~17s bounded probe and could push
    // checkWorkspaceAccessible past the 18s wrapper. The remediation detector must
    // be gated behind !cloudInfo.isCloud, so on a known-cloud timeout it is never
    // called. FAIL-ON-REVERT: dropping the `!cloudInfo.isCloud` gate makes this
    // detector get invoked → call count > 0.
    const { detectCloudStorage, detectInPlaceCloudDocuments } = await import(
      '../../../../utils/cloudStorageUtils'
    );
    vi.mocked(detectCloudStorage).mockReturnValue({ isCloud: true, provider: 'icloud' });

    mockStat.mockImplementation(async () => {
      throw new Error("Operation 'stat' timed out after 15000ms");
    });
    mockUnlink.mockResolvedValue(undefined);

    const result = await checkWorkspaceAccessible(SETTINGS);

    expect(result.status).toBe('fail');
    // Known-cloud syncing copy is used...
    expect(result.message).toMatch(/syncing from iCloud/i);
    // ...and the in-place detector was NOT invoked in the remediation path.
    expect(detectInPlaceCloudDocuments).not.toHaveBeenCalled();
  });
});
