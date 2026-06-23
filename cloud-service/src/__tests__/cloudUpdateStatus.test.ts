import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks – declared before imports so vi.mock hoisting works correctly
// ---------------------------------------------------------------------------

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockCaptureMessage = vi.fn();

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({
    captureException: vi.fn(),
    captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
    addBreadcrumb: vi.fn(),
  }),
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeCloudUpdateStatus,
  reportRollbackIfNew,
} from '../services/cloudUpdateStatus';
import { createQuarantinedTagsStore } from '../services/quarantinedTagsStore';
import { createLastKnownGoodImageTagStore } from '../services/lastKnownGoodImageTagStore';

const FIXED_NOW = 1_000_000_000;
const TTL = 7 * 24 * 60 * 60 * 1000;

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-update-status-'));
}

describe('cloudUpdateStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // computeCloudUpdateStatus
  // -----------------------------------------------------------------------

  describe('computeCloudUpdateStatus', () => {
    it('returns "ok" with no quarantine entries', () => {
      const result = computeCloudUpdateStatus({
        dataDir: tmpDir,
        currentImageTag: 'ghcr.io/mindstone/rebel-cloud:prod-good',
        now: () => FIXED_NOW,
      });
      expect(result.status).toBe('ok');
      expect(result.quarantinedTags).toEqual([]);
      expect(result.currentImageTag).toBe('ghcr.io/mindstone/rebel-cloud:prod-good');
    });

    it('returns "recently-rolled-back" with active quarantine + surfaces tags and LKG', () => {
      const quarantineStore = createQuarantinedTagsStore({ dataPath: tmpDir });
      quarantineStore.addRejected('ghcr.io/mindstone/rebel-cloud:prod-bad', {
        ttlMs: TTL,
        now: FIXED_NOW,
      });
      const lkgStore = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
      lkgStore.write({
        version: 1,
        imageTag: 'ghcr.io/mindstone/rebel-cloud:prod-good',
        buildCommit: 'good123',
        schemaFingerprint: 'fp',
        recordedAt: FIXED_NOW,
        previousLastKnownGood: null,
      });

      const result = computeCloudUpdateStatus({
        dataDir: tmpDir,
        currentImageTag: 'ghcr.io/mindstone/rebel-cloud:prod-good',
        now: () => FIXED_NOW,
      });

      expect(result.status).toBe('recently-rolled-back');
      expect(result.quarantinedTags).toEqual(['ghcr.io/mindstone/rebel-cloud:prod-bad']);
      expect(result.lastKnownGoodImageTag).toBe('ghcr.io/mindstone/rebel-cloud:prod-good');
    });

    it('treats an expired quarantine entry as "ok"', () => {
      const quarantineStore = createQuarantinedTagsStore({ dataPath: tmpDir });
      quarantineStore.addRejected('ghcr.io/mindstone/rebel-cloud:prod-bad', {
        ttlMs: TTL,
        now: FIXED_NOW - TTL - 1, // already expired by FIXED_NOW
      });

      const result = computeCloudUpdateStatus({ dataDir: tmpDir, now: () => FIXED_NOW });
      expect(result.status).toBe('ok');
      expect(result.quarantinedTags).toEqual([]);
    });

    it('degrades to "ok" (does not throw) when the quarantine store read fails', () => {
      const throwingStore = {
        readActive: () => {
          throw new Error('disk gone');
        },
        addRejected: vi.fn(),
        clear: vi.fn(),
        filePath: () => '',
      };
      const result = computeCloudUpdateStatus({
        dataDir: tmpDir,
        quarantineStore: throwingStore,
        now: () => FIXED_NOW,
      });
      expect(result.status).toBe('ok');
      expect(result.quarantinedTags).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // reportRollbackIfNew
  // -----------------------------------------------------------------------

  describe('reportRollbackIfNew', () => {
    function seedQuarantine(tag: string, rejectedAt: number): void {
      const store = createQuarantinedTagsStore({ dataPath: tmpDir });
      store.addRejected(tag, { ttlMs: TTL, now: rejectedAt });
    }

    it('does not report when there is no active quarantine', () => {
      const result = reportRollbackIfNew({ dataDir: tmpDir, now: () => FIXED_NOW });
      expect(result.reported).toBe(false);
      expect(mockCaptureMessage).not.toHaveBeenCalled();
    });

    it('reports once with the rolled-back-from tag and writes the dedup marker', () => {
      seedQuarantine('ghcr.io/mindstone/rebel-cloud:prod-bad', FIXED_NOW);

      const result = reportRollbackIfNew({
        dataDir: tmpDir,
        currentImageTag: 'ghcr.io/mindstone/rebel-cloud:prod-good',
        now: () => FIXED_NOW,
      });

      expect(result.reported).toBe(true);
      expect(result.rolledBackFromTag).toBe('ghcr.io/mindstone/rebel-cloud:prod-bad');
      expect(mockCaptureMessage).toHaveBeenCalledWith(
        'cloud.image_rollback.recovered',
        expect.objectContaining({
          level: 'error',
          fingerprint: ['cloud.image_rollback.recovered'],
          tags: expect.objectContaining({ event: 'cloud.image_rollback.recovered', surface: 'cloud' }),
          extra: expect.objectContaining({
            rolledBackFromTag: 'ghcr.io/mindstone/rebel-cloud:prod-bad',
            currentImageTag: 'ghcr.io/mindstone/rebel-cloud:prod-good',
          }),
        }),
      );
      // Marker persisted
      expect(fs.existsSync(path.join(tmpDir, '.rollback-reported.json'))).toBe(true);
    });

    it('does not re-report the same rollback on a subsequent boot (dedup via marker)', () => {
      seedQuarantine('ghcr.io/mindstone/rebel-cloud:prod-bad', FIXED_NOW);

      const first = reportRollbackIfNew({ dataDir: tmpDir, now: () => FIXED_NOW });
      expect(first.reported).toBe(true);
      mockCaptureMessage.mockClear();

      const second = reportRollbackIfNew({ dataDir: tmpDir, now: () => FIXED_NOW + 60_000 });
      expect(second.reported).toBe(false);
      expect(mockCaptureMessage).not.toHaveBeenCalled();
    });

    it('reports again when a NEWER rollback is quarantined after the marker', () => {
      seedQuarantine('ghcr.io/mindstone/rebel-cloud:prod-bad1', FIXED_NOW);
      reportRollbackIfNew({ dataDir: tmpDir, now: () => FIXED_NOW });
      mockCaptureMessage.mockClear();

      // A new bad image is later rejected.
      seedQuarantine('ghcr.io/mindstone/rebel-cloud:prod-bad2', FIXED_NOW + 100_000);

      const result = reportRollbackIfNew({ dataDir: tmpDir, now: () => FIXED_NOW + 200_000 });
      expect(result.reported).toBe(true);
      expect(result.rolledBackFromTag).toBe('ghcr.io/mindstone/rebel-cloud:prod-bad2');
      expect(mockCaptureMessage).toHaveBeenCalledOnce();
    });

    it('re-reports on the next boot when the marker write fails after a successful capture', () => {
      seedQuarantine('ghcr.io/mindstone/rebel-cloud:prod-bad', FIXED_NOW);
      const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
        throw new Error('ENOSPC: disk full');
      });

      const first = reportRollbackIfNew({ dataDir: tmpDir, now: () => FIXED_NOW });
      expect(first.reported).toBe(true); // capture succeeded even though marker persist failed
      expect(mockCaptureMessage).toHaveBeenCalledOnce();
      // Marker not persisted → no dedup recorded.
      expect(fs.existsSync(path.join(tmpDir, '.rollback-reported.json'))).toBe(false);

      writeSpy.mockRestore();
      mockCaptureMessage.mockClear();

      // Next boot: marker absent → the same rollback is re-reported (acceptable;
      // groups into one issue via fingerprint, just an inflated count).
      const second = reportRollbackIfNew({ dataDir: tmpDir, now: () => FIXED_NOW + 60_000 });
      expect(second.reported).toBe(true);
      expect(mockCaptureMessage).toHaveBeenCalledOnce();
    });

    it('fail-safe: returns reported=false and writes no marker when capture throws', () => {
      seedQuarantine('ghcr.io/mindstone/rebel-cloud:prod-bad', FIXED_NOW);
      mockCaptureMessage.mockImplementationOnce(() => {
        throw new Error('sentry down');
      });

      const result = reportRollbackIfNew({ dataDir: tmpDir, now: () => FIXED_NOW });
      expect(result.reported).toBe(false);
      // Marker NOT written → next boot will retry the report.
      expect(fs.existsSync(path.join(tmpDir, '.rollback-reported.json'))).toBe(false);
    });
  });
});
