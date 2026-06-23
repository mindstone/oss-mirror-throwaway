/**
 * Regression test for REBEL-1C8: settingsStore reads crash on EMFILE.
 *
 * Bug: The `conf` library's `.store` getter calls `fs.readFileSync()` on every
 * access with no in-memory caching. When the Windows process exhausts its file
 * descriptor limit (after 20+ hours of runtime), EVERY settings read fails with
 * EMFILE, causing a cascade of 11 fatal uncaught exceptions.
 *
 * Fix: getSettings() should return an in-memory cached copy. It should only
 * read from disk on startup and invalidate the cache on writes.
 *
 * TDD approach: This test should FAIL (RED) before the fix and PASS (GREEN) after.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppSettings } from '@shared/types';

// Track readFileSync calls to prove caching works
let readFileSyncCallCount = 0;

vi.mock('electron-store', () => {
  const DEFAULT_DATA: Record<string, unknown> = {
    diagnostics: { debugBreadcrumbsUntil: null },
    claude: { apiKey: 'test-key', model: 'claude-sonnet-4' },
  };

  return {
    default: class MockStore {
      private _data: Record<string, unknown>;

      constructor() {
        this._data = { ...DEFAULT_DATA };
      }

      get store(): Record<string, unknown> {
        // Simulate conf's behavior: readFileSync on EVERY access
        readFileSyncCallCount++;
        return { ...this._data };
      }

      set store(val: Record<string, unknown>) {
        this._data = { ...val };
      }

      get(_key: string) {
        readFileSyncCallCount++;
        return this._data;
      }

      set(_key: string, _val: unknown) {
        // no-op for test
      }

      delete(_key: string) {
        // no-op for test
      }
    },
  };
});

describe('REBEL-1C8: settingsStore read caching', () => {
  beforeEach(() => {
    readFileSyncCallCount = 0;
  });

  it('should not call readFileSync on every getSettings() invocation (precondition — confirms the bug)', async () => {
    // Import after mock
    const { getSettings } = await import('../settingsStore');

    // Bootstrap migrations + diagnostics prime are now DEFERRED to the first
    // settings access (OSS boot-crash fix), so that first call legitimately does
    // disk reads. Prime boot once, THEN reset the disk-read counter so the
    // hot-path measurement below excludes the one-time boot I/O.
    getSettings();
    readFileSyncCallCount = 0;

    // Simulate hot path: 100 rapid getSettings() calls (renderer console-message handler)
    for (let i = 0; i < 100; i++) {
      getSettings();
    }

    // BEFORE FIX: readFileSyncCallCount will be >= 100 (one per call)
    // AFTER FIX: readFileSyncCallCount should be <= 1 (cached after first read)
    //
    // This test documents the expected behavior after caching is implemented.
    // It will FAIL before the fix (confirming the bug) and PASS after.
    expect(readFileSyncCallCount).toBeLessThanOrEqual(1);
  });

  it('should return consistent settings data even when read count is minimized', async () => {
    const { getSettings } = await import('../settingsStore');

    const settings1 = getSettings();
    const settings2 = getSettings();

    // Settings should be equivalent regardless of caching
    expect(settings1).toEqual(settings2);
  });
});
