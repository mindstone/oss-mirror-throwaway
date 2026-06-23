/**
 * Stage 10 — coarse OP-LEVEL bound on cloud workspace sync.
 *
 * `buildLocalManifest` DELIBERATELY mirrors the full local workspace including
 * directory symlinks into cloud storage (`skipCloudSymlinkTargets: false`), so
 * on a dead/unresponsive cloud mount the walk could otherwise drip entries
 * unbounded. These tests prove:
 *
 *  1. The walk is given an overall abort `signal` (the coarse op-level bound).
 *  2. A DEAD mount (walk never settles on its own) does NOT hang sync: the
 *     deadline aborts the walk, the manifest is reported INCOMPLETE
 *     (`complete: false`, `'aborted'` reason), and a distinct warning is logged
 *     — an observable partial outcome, never a silent success.
 *  3. A HEALTHY mount still mirrors content: the walk runs to completion and the
 *     manifest is `complete: true` with no `'aborted'` reason (behavior
 *     preserved).
 *
 * `safeWalkDirectory` is mocked here so the dead/healthy mount can be simulated
 * deterministically without a real Drive mount or a real 60s wait. The real
 * walker's between-entry `signal.aborted` semantics are covered by
 * safeWalkDirectory.test.ts; this file covers cloud-sync's WIRING of the bound.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { resetSessionMutexForTests } from '@core/services/sessionMutex';
import type { SafeWalkOptions, SafeWalkResult } from '@core/utils/safeWalkDirectory';

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-workspace-sync-oplevel',
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => loggerMock,
}));

// Mock the shared walker so we can simulate a dead vs. healthy mount and assert
// the signal wiring, without touching real disk for the walk itself.
const safeWalkDirectoryMock = vi.hoisted(() => vi.fn());
vi.mock('@core/utils/safeWalkDirectory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/utils/safeWalkDirectory')>();
  return {
    ...actual,
    safeWalkDirectory: safeWalkDirectoryMock,
  };
});

import { CloudWorkspaceSync } from '../cloudWorkspaceSync';

const WORKSPACE_DIR = '/tmp/test-cloud-workspace-sync-oplevel/workspace';

function cleanupDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
}

describe('CloudWorkspaceSync — Stage 10 op-level bound (buildLocalManifest)', () => {
  let sync: CloudWorkspaceSync;

  beforeEach(() => {
    sync = new CloudWorkspaceSync();
    cleanupDir('/tmp/test-cloud-workspace-sync-oplevel');
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    loggerMock.info.mockClear();
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
    loggerMock.debug.mockClear();
    safeWalkDirectoryMock.mockReset();
  });

  afterEach(() => {
    sync._resetForTesting();
    resetSessionMutexForTests();
    cleanupDir('/tmp/test-cloud-workspace-sync-oplevel');
  });

  it('passes an abort signal into the walk (the coarse op-level bound is wired)', async () => {
    safeWalkDirectoryMock.mockImplementation(
      async (_root: string, opts: SafeWalkOptions): Promise<SafeWalkResult> => {
        expect(opts.signal).toBeInstanceOf(AbortSignal);
        expect(opts.signal?.aborted).toBe(false);
        // Healthy fast walk — opt out of cloud skip preserved.
        expect(opts.skipCloudSymlinkTargets).toBe(false);
        return { entriesVisited: 0, truncatedReasons: [], rootRealPath: WORKSPACE_DIR };
      },
    );

    const result = await sync.buildLocalManifest(WORKSPACE_DIR);

    expect(safeWalkDirectoryMock).toHaveBeenCalledTimes(1);
    expect(result.complete).toBe(true);
  });

  it('DEAD mount: deadline aborts the walk, manifest is incomplete + observable (no silent success, no hang)', async () => {
    vi.useFakeTimers();
    try {
      // Simulate a dead/unresponsive mount: the walk only settles when the
      // op-level deadline aborts its signal (mirrors the real walker's
      // between-entry `signal.aborted` check on a wedged subtree). Without the
      // op-level bound this promise would never resolve ⇒ sync would hang.
      safeWalkDirectoryMock.mockImplementation(
        (_root: string, opts: SafeWalkOptions): Promise<SafeWalkResult> => {
          return new Promise<SafeWalkResult>((resolve) => {
            const signal = opts.signal;
            if (!signal) throw new Error('expected an abort signal');
            signal.addEventListener('abort', () => {
              resolve({
                entriesVisited: 3,
                // The real walker records 'aborted' when the signal fires
                // between entries.
                truncatedReasons: ['aborted'],
                rootRealPath: WORKSPACE_DIR,
              });
            });
          });
        },
      );

      const manifestPromise = sync.buildLocalManifest(WORKSPACE_DIR);

      // Fast-forward past the op-level deadline (60s) — fires the abort.
      await vi.advanceTimersByTimeAsync(60_001);

      const result = await manifestPromise;

      // Observable partial outcome — NOT a silent success.
      expect(result.complete).toBe(false);
      expect(result.reasons).toContain('aborted');

      // Distinct, greppable dead-mount warning surfaced.
      const warnedDeadline = loggerMock.warn.mock.calls.some(
        ([, msg]) => typeof msg === 'string' && /cloud mount unresponsive/i.test(msg),
      );
      expect(warnedDeadline).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('HEALTHY mount: walk runs to completion and mirrors content (behavior preserved)', async () => {
    safeWalkDirectoryMock.mockImplementation(
      async (_root: string, opts: SafeWalkOptions): Promise<SafeWalkResult> => {
        // Healthy mount returns promptly; emit one file so the manifest mirrors it.
        await opts.onFile?.({
          absolutePath: path.join(WORKSPACE_DIR, 'drive-doc.md'),
          name: 'drive-doc.md',
          parentDir: WORKSPACE_DIR,
          depth: 0,
          viaSymlink: true,
        });
        return { entriesVisited: 1, truncatedReasons: [], rootRealPath: WORKSPACE_DIR };
      },
    );

    // Back the emitted file with real bytes so statSync/hashFile succeed.
    fs.writeFileSync(path.join(WORKSPACE_DIR, 'drive-doc.md'), 'mirrored cloud content', 'utf8');

    const result = await sync.buildLocalManifest(WORKSPACE_DIR);

    expect(result.complete).toBe(true);
    expect(result.reasons).not.toContain('aborted');
    expect(result.manifest.has('drive-doc.md')).toBe(true);

    // No dead-mount warning on a healthy mount.
    const warnedDeadline = loggerMock.warn.mock.calls.some(
      ([, msg]) => typeof msg === 'string' && /cloud mount unresponsive/i.test(msg),
    );
    expect(warnedDeadline).toBe(false);
  });
});
