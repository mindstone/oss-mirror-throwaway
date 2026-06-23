import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    warn: warnSpy,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-pending-update-unused',
}));

import {
  _resetPendingCloudUpdatesForTesting,
  clearPendingCloudUpdate,
  getPendingCloudUpdate,
  getPendingCloudUpdates,
  recordPendingCloudUpdate,
  updatePendingCloudUpdateCloudHash,
} from '../cloudPendingUpdateStore';

let tmpRoot: string;
let storePath: string;
const WORKSPACE = '/some/workspace';

beforeEach(() => {
  warnSpy.mockClear();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-update-test-'));
  storePath = path.join(tmpRoot, 'cloud-pending-updates.json');
  _resetPendingCloudUpdatesForTesting(storePath);
});

afterEach(() => {
  _resetPendingCloudUpdatesForTesting(null);
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe('cloudPendingUpdateStore — atomic persist + restart', () => {
  it('persists atomically (no temp residue) and survives a restart', () => {
    recordPendingCloudUpdate({
      coreDirectory: WORKSPACE,
      relativePath: 'notes/a.md',
      cloudHash: 'cloudhash1',
      baselineLocalHash: 'localhash1',
    });

    expect(fs.existsSync(storePath)).toBe(true);
    const dirEntries = fs.readdirSync(path.dirname(storePath));
    expect(dirEntries.some((name) => name.includes('.rebel-cloud-pull.tmp'))).toBe(false);

    // Simulate restart: drop in-memory state, reload from disk.
    _resetPendingCloudUpdatesForTesting(storePath);
    const reloaded = getPendingCloudUpdates(WORKSPACE);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({
      relativePath: 'notes/a.md',
      cloudHash: 'cloudhash1',
      baselineLocalHash: 'localhash1',
    });
  });
});

describe('cloudPendingUpdateStore — clearing semantics', () => {
  it('clears on explicit convergence/resolution', () => {
    recordPendingCloudUpdate({
      coreDirectory: WORKSPACE,
      relativePath: 'notes/a.md',
      cloudHash: 'cloudhash1',
      baselineLocalHash: 'localhash1',
    });
    expect(getPendingCloudUpdates(WORKSPACE)).toHaveLength(1);

    expect(clearPendingCloudUpdate(WORKSPACE, 'notes/a.md')).toBe(true);
    expect(getPendingCloudUpdates(WORKSPACE)).toHaveLength(0);

    // Persisted clear survives restart.
    _resetPendingCloudUpdatesForTesting(storePath);
    expect(getPendingCloudUpdates(WORKSPACE)).toHaveLength(0);
  });

  it('re-records with the new cloud hash when the cloud version changes', () => {
    const first = recordPendingCloudUpdate({
      coreDirectory: WORKSPACE,
      relativePath: 'notes/a.md',
      cloudHash: 'cloudhash1',
      baselineLocalHash: 'localhash1',
      nowMs: 1000,
    });

    const second = recordPendingCloudUpdate({
      coreDirectory: WORKSPACE,
      relativePath: 'notes/a.md',
      cloudHash: 'cloudhash2',
      baselineLocalHash: 'localhash1',
      nowMs: 2000,
    });

    const pending = getPendingCloudUpdates(WORKSPACE);
    expect(pending).toHaveLength(1);
    expect(pending[0].cloudHash).toBe('cloudhash2');
    // firstSeenAt is preserved across re-records; lastSeenAt advances.
    expect(first.firstSeenAt).toBe(1000);
    expect(second.firstSeenAt).toBe(1000);
    expect(second.lastSeenAt).toBe(2000);
  });
});

describe('cloudPendingUpdateStore — corrupt-store resilience', () => {
  it('clears on a corrupt store but logs it (self-heals from next manifest fetch)', () => {
    recordPendingCloudUpdate({
      coreDirectory: WORKSPACE,
      relativePath: 'notes/a.md',
      cloudHash: 'cloudhash1',
      baselineLocalHash: 'localhash1',
    });

    fs.writeFileSync(storePath, '{ not valid json', 'utf8');
    _resetPendingCloudUpdatesForTesting(storePath);

    expect(getPendingCloudUpdates(WORKSPACE)).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ storePath }),
      expect.stringContaining('Failed to load pending-cloud-update store'),
    );
  });

  it('clears + logs when the store is valid JSON but not an array', () => {
    fs.writeFileSync(storePath, JSON.stringify({ nope: true }), 'utf8');
    _resetPendingCloudUpdatesForTesting(storePath);

    expect(getPendingCloudUpdates(WORKSPACE)).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ storePath }),
      expect.stringContaining('not a JSON array'),
    );
  });
});

describe('cloudPendingUpdateStore — in-place cloud-hash compression', () => {
  it('getPendingCloudUpdate returns the single record (or null)', () => {
    expect(getPendingCloudUpdate(WORKSPACE, 'notes/a.md')).toBeNull();
    recordPendingCloudUpdate({
      coreDirectory: WORKSPACE,
      relativePath: 'notes/a.md',
      cloudHash: 'cloudhash1',
      baselineLocalHash: 'localhash1',
      nowMs: 1000,
    });
    expect(getPendingCloudUpdate(WORKSPACE, 'notes/a.md')).toEqual(
      expect.objectContaining({ relativePath: 'notes/a.md', cloudHash: 'cloudhash1', baselineLocalHash: 'localhash1' }),
    );
  });

  it('updatePendingCloudUpdateCloudHash refreshes cloudHash in place, keeping firstSeenAt + baseline stable', () => {
    recordPendingCloudUpdate({
      coreDirectory: WORKSPACE,
      relativePath: 'notes/a.md',
      cloudHash: 'cloudhash1',
      baselineLocalHash: 'localhash1',
      nowMs: 1000,
    });

    const updated = updatePendingCloudUpdateCloudHash({
      coreDirectory: WORKSPACE,
      relativePath: 'notes/a.md',
      cloudHash: 'cloudhash2',
      nowMs: 2000,
    });

    expect(updated).not.toBeNull();
    expect(updated?.cloudHash).toBe('cloudhash2');
    // firstSeenAt + baseline are the data-safety invariants — they MUST NOT move.
    expect(updated?.firstSeenAt).toBe(1000);
    expect(updated?.baselineLocalHash).toBe('localhash1');
    expect(updated?.lastSeenAt).toBe(2000);

    const stored = getPendingCloudUpdates(WORKSPACE);
    expect(stored).toHaveLength(1);
    expect(stored[0].cloudHash).toBe('cloudhash2');
    expect(stored[0].firstSeenAt).toBe(1000);
  });

  it('updatePendingCloudUpdateCloudHash returns null when no record exists (caller must record fresh)', () => {
    expect(
      updatePendingCloudUpdateCloudHash({
        coreDirectory: WORKSPACE,
        relativePath: 'notes/missing.md',
        cloudHash: 'cloudhash2',
      }),
    ).toBeNull();
    expect(getPendingCloudUpdates(WORKSPACE)).toHaveLength(0);
  });
});
