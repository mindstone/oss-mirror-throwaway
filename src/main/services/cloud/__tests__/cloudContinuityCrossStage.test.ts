import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GC_GRACE_WINDOW_MS,
  mergePreservingCloudActive,
  runStateMapGC,
} from '@core/services/cloudContinuityStateService';
import type { ContinuityStateMap } from '@core/services/continuity/continuityStateTypes';

vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-continuity-cross-stage',
}));

import {
  _resetForTesting,
  getAllContinuityStates,
  markCloudActive,
  markLocalOnly,
} from '../cloudContinuityMetadata';

const META_PATH = path.join('/tmp/test-cloud-continuity-cross-stage', 'sessions', 'cloud-continuity-meta.json');

function oldEnoughSummary(id: string) {
  return { id, updatedAt: Date.now() - GC_GRACE_WINDOW_MS - 10_000 };
}

describe('cloudContinuityCrossStage (desktop+core)', () => {
  beforeEach(() => {
    _resetForTesting();
    try {
      fs.rmSync(path.dirname(META_PATH), { recursive: true, force: true });
    } catch {
      // noop
    }
  });

  afterEach(() => {
    _resetForTesting();
    try {
      fs.rmSync(path.dirname(META_PATH), { recursive: true, force: true });
    } catch {
      // noop
    }
  });

  it('preserves cloud_active when desktop pushes inferred local_only without intent', async () => {
    const existing: ContinuityStateMap = {
      X: { state: 'cloud_active' },
    };
    const inferredDesktopPush: ContinuityStateMap = {
      X: { state: 'local_only' },
    };

    const mergedResult = mergePreservingCloudActive(inferredDesktopPush, existing);
    expect(mergedResult.refused).toBe(1);
    expect(mergedResult.merged.X?.state).toBe('cloud_active');

    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const sink = { emit: vi.fn() };
    const gc = await runStateMapGC(
      mergedResult.merged,
      {
        listSessions: () => [oldEnoughSummary('X')],
        deleteSession,
      },
      sink,
    );

    expect(deleteSession).not.toHaveBeenCalled();
    expect(gc.deleted).toEqual([]);
    expect(gc.gcDeleted).toBe(0);
  });

  it('accepts user-initiated demotion and deletes after grace window', async () => {
    markCloudActive('Y');
    markLocalOnly('Y', 'manual-reset', 'user');
    const outgoingDesktopMap = getAllContinuityStates();
    const existingCloudMap: ContinuityStateMap = {
      Y: { state: 'cloud_active' },
    };

    const mergedResult = mergePreservingCloudActive(outgoingDesktopMap, existingCloudMap);
    expect(mergedResult.refused).toBe(0);
    expect(mergedResult.merged.Y?.state).toBe('local_only');
    expect(mergedResult.merged.Y?.cloudRemovalIntent?.requestedBy).toBe('user');

    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const sink = { emit: vi.fn() };
    const gc = await runStateMapGC(
      mergedResult.merged,
      {
        listSessions: () => [oldEnoughSummary('Y')],
        deleteSession,
      },
      sink,
    );

    expect(deleteSession).toHaveBeenCalledWith('Y', { intent: 'hygiene' });
    expect(gc.deleted).toEqual(['Y']);
  });

  it('accepts retention-policy demotion as visibility-only and keeps session file', async () => {
    markCloudActive('Z');
    markLocalOnly('Z', 'cloud-disabled', 'retention-policy');
    const outgoingDesktopMap = getAllContinuityStates();
    const existingCloudMap: ContinuityStateMap = {
      Z: { state: 'cloud_active' },
    };

    const mergedResult = mergePreservingCloudActive(outgoingDesktopMap, existingCloudMap);
    expect(mergedResult.refused).toBe(0);
    expect(mergedResult.merged.Z?.state).toBe('local_only');
    expect(mergedResult.merged.Z?.cloudRemovalIntent?.requestedBy).toBe('retention-policy');

    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const sink = { emit: vi.fn() };
    const gc = await runStateMapGC(
      mergedResult.merged,
      {
        listSessions: () => [oldEnoughSummary('Z')],
        deleteSession,
      },
      sink,
    );

    expect(deleteSession).not.toHaveBeenCalled();
    expect(gc.deleted).toEqual([]);
    expect(gc.protected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: 'Z',
          reason: 'retention-policy-visibility-only',
        }),
      ]),
    );
  });
});
