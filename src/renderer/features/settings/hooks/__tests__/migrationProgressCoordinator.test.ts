/**
 * Regression tests for the migrationProgressCoordinator flag flipping.
 *
 * `useCloudSync` gates its `cloud:migration-progress` listener on
 * `isMigrationInProgress()`. Before Stage 2's fix, the provider-switch
 * flow in `useCloudProvisioning` did not flip that flag, so the main
 * process's migration events silently disappeared during a switch.
 *
 * These tests lock the coordinator behaviour in place so a future
 * refactor cannot silently revert to the dropped-events state.
 *
 * See planning doc:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 *   (Stage 2 — Review-Driven Amendments → `_syncInProgress` flag coverage)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { CloudMigrationProgress } from '@shared/cloudMigrationTypes';
import {
  beginExternalMigration,
  endExternalMigration,
  getLastProgress,
  isMigrationInProgress,
  setLastProgress,
  setSyncInProgress,
  __resetMigrationCoordinatorForTesting,
} from '../migrationProgressCoordinator';

beforeEach(() => {
  __resetMigrationCoordinatorForTesting();
});

describe('migrationProgressCoordinator', () => {
  it('reports no migration in progress initially', () => {
    expect(isMigrationInProgress()).toBe(false);
    expect(getLastProgress()).toBeNull();
  });

  it('beginExternalMigration flips the flag so useCloudSync forwards events', () => {
    beginExternalMigration();
    expect(isMigrationInProgress()).toBe(true);
  });

  it('endExternalMigration clears both the flag and last-progress snapshot', () => {
    beginExternalMigration();
    setLastProgress({
      phase: 'workspace',
      message: 'Uploading workspace...',
      progress: 15,
    });
    expect(isMigrationInProgress()).toBe(true);
    expect(getLastProgress()).not.toBeNull();

    endExternalMigration();

    expect(isMigrationInProgress()).toBe(false);
    expect(getLastProgress()).toBeNull();
  });

  it('setSyncInProgress(false) overrides a prior beginExternalMigration (migrate() completion path)', () => {
    beginExternalMigration();
    expect(isMigrationInProgress()).toBe(true);

    // Simulates useCloudSync.migrate() finishing successfully — it clears
    // the flag directly via setSyncInProgress instead of calling
    // endExternalMigration.
    setSyncInProgress(false);

    expect(isMigrationInProgress()).toBe(false);
  });

  it('__resetMigrationCoordinatorForTesting wipes everything', () => {
    beginExternalMigration();
    setLastProgress({ phase: 'extract', message: 'Extracting...', progress: 25 });

    __resetMigrationCoordinatorForTesting();

    expect(isMigrationInProgress()).toBe(false);
    expect(getLastProgress()).toBeNull();
  });
});

describe('provider-switch regression: UI receives migration events during switch', () => {
  it('progress events arriving between begin/end are captured via the coordinator', () => {
    // Arrange: simulate the useCloudSync listener's gating logic.
    const captured: Array<{ phase: CloudMigrationProgress['phase']; progress: number }> = [];
    const onMigrationProgress = (step: CloudMigrationProgress) => {
      if (isMigrationInProgress()) {
        setLastProgress(step);
        captured.push({ phase: step.phase, progress: step.progress });
      }
    };

    // Act: provider-switch flow calls beginExternalMigration, main process
    // emits events, then provider-switch calls endExternalMigration.
    beginExternalMigration();
    onMigrationProgress({ phase: 'workspace', message: 'Uploading...', progress: 10 });
    onMigrationProgress({ phase: 'workspace', message: 'Still uploading...', progress: 18 });
    onMigrationProgress({ phase: 'extract', message: 'Extracting on cloud...', progress: 25 });
    endExternalMigration();

    // Post-switch events (after endExternalMigration) must be dropped.
    onMigrationProgress({ phase: 'complete', message: 'Done', progress: 100 });

    // Assert: the three in-flight events were captured, the tail was not.
    expect(captured).toEqual([
      { phase: 'workspace', progress: 10 },
      { phase: 'workspace', progress: 18 },
      { phase: 'extract', progress: 25 },
    ]);
  });

  it('without beginExternalMigration, no events are captured (pre-fix behaviour, negative control)', () => {
    const captured: Array<{ phase: CloudMigrationProgress['phase'] }> = [];
    const onMigrationProgress = (step: CloudMigrationProgress) => {
      if (isMigrationInProgress()) {
        captured.push({ phase: step.phase });
      }
    };

    // Do NOT call beginExternalMigration — this is the pre-Stage 2 bug state.
    onMigrationProgress({ phase: 'workspace', message: 'Uploading...', progress: 10 });
    onMigrationProgress({ phase: 'extract', message: 'Extracting...', progress: 25 });

    expect(captured).toEqual([]);
  });
});
