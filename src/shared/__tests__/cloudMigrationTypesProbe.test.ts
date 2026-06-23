/**
 * Stage 8 — cross-surface type-only import probe for cloud migration types.
 *
 * The `MigrationStep` / `MIGRATION_PHASE_RANGES` / `FootprintOutcome` types
 * are consumed across three surfaces (desktop, cloud-service, future mobile)
 * and a build break in one surface will not automatically fail the default
 * vitest pass (each surface has its own tsconfig). This probe is a belt-and-
 * braces check: if the shape of the shared types drifts underneath, the
 * `expectTypeOf` assertions below will fail the main desktop test run and
 * call attention to the drift before a mobile release regresses.
 *
 * Uses `import type` + `expectTypeOf` rather than runtime `.toBe(...)` so
 * the test also exercises TS's narrowing on the discriminated union.
 *
 * See planning doc:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 *   (Stage 8 — Cross-surface type-only import probes)
 */

import { describe, it, expect, expectTypeOf } from 'vitest';

import {
  MIGRATION_PHASE_RANGES,
  mapToPhaseRange,
  phaseIdToRangeKey,
  type MigrationPhase,
} from '@shared/cloudMigrationPhases';

import type {
  MigrationStep,
  MigrationPhaseId,
  CloudMigrationProgress,
  FootprintOutcome,
} from '@shared/cloudMigrationTypes';

describe('cross-surface type probe — cloud migration types', () => {
  // ---------------------------------------------------------------------------
  // MigrationStep shape
  // ---------------------------------------------------------------------------

  it('MigrationStep has the expected required + optional field shape', () => {
    // Minimal (required-fields-only) step must compile.
    const minimal: MigrationStep = {
      phase: 'settings',
      message: 'Starting',
      progress: 0,
    };
    expect(minimal.phase).toBe('settings');

    // Full shape with every optional field must compile. This is the exact
    // object shape that the cloudHandlers.ts broadcast constructs.
    const full: Required<MigrationStep> = {
      phase: 'workspace',
      message: 'Uploading workspace... 240/900 MB sent',
      progress: 17.5,
      current: 251_658_240,
      total: 943_718_400,
      bytesTotal: 943_718_400,
      live: true,
      runId: '11111111-2222-3333-4444-555555555555',
    };
    expect(full.runId).toBe('11111111-2222-3333-4444-555555555555');

    // Required keys — if any of these disappear, the type signature regressed.
    expectTypeOf<MigrationStep>().toHaveProperty('phase');
    expectTypeOf<MigrationStep>().toHaveProperty('message');
    expectTypeOf<MigrationStep>().toHaveProperty('progress');

    // Optional keys — keep them optional (undefined in the type) so existing
    // producers don't have to populate them.
    expectTypeOf<MigrationStep['current']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<MigrationStep['total']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<MigrationStep['bytesTotal']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<MigrationStep['live']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<MigrationStep['runId']>().toEqualTypeOf<string | undefined>();
  });

  it('CloudMigrationProgress is an alias of MigrationStep', () => {
    expectTypeOf<CloudMigrationProgress>().toEqualTypeOf<MigrationStep>();
  });

  it('MigrationPhaseId union covers every phase the producer emits', () => {
    expectTypeOf<MigrationPhaseId>().toEqualTypeOf<
      'settings' | 'mcp-config' | 'workspace' | 'extract' | 'app-data' | 'sessions' | 'complete'
    >();
  });

  // ---------------------------------------------------------------------------
  // MIGRATION_PHASE_RANGES const-ness + mapping
  // ---------------------------------------------------------------------------

  it('MIGRATION_PHASE_RANGES is `as const`/readonly (literal min/max baked in)', () => {
    // The `as const` assertion gives us literal types. If the `as const` is
    // removed, these literal assertions break.
    expectTypeOf(MIGRATION_PHASE_RANGES.settings.min).toEqualTypeOf<0>();
    expectTypeOf(MIGRATION_PHASE_RANGES.settings.max).toEqualTypeOf<5>();
    expectTypeOf(MIGRATION_PHASE_RANGES.workspace.min).toEqualTypeOf<10>();
    expectTypeOf(MIGRATION_PHASE_RANGES.workspace.max).toEqualTypeOf<22>();
    expectTypeOf(MIGRATION_PHASE_RANGES.extract.min).toEqualTypeOf<22>();
    expectTypeOf(MIGRATION_PHASE_RANGES.extract.max).toEqualTypeOf<30>();
    expectTypeOf(MIGRATION_PHASE_RANGES.complete.max).toEqualTypeOf<100>();
  });

  it('MigrationPhase is the exhaustive key union of the phase-range map', () => {
    expectTypeOf<MigrationPhase>().toEqualTypeOf<
      'settings' | 'mcp' | 'workspace' | 'extract' | 'appdata' | 'sessions' | 'complete'
    >();
  });

  it('phaseIdToRangeKey maps event-phase ids to range keys', () => {
    // These are value-level assertions — just sanity-check the two
    // spelling-bridge cases so the test doesn't accept a regression that
    // removed the mapper.
    expect(phaseIdToRangeKey('mcp-config')).toBe('mcp');
    expect(phaseIdToRangeKey('app-data')).toBe('appdata');
    expect(phaseIdToRangeKey('workspace')).toBe('workspace');
    expect(phaseIdToRangeKey('extract')).toBe('extract');
    expect(phaseIdToRangeKey('settings')).toBe('settings');
    expect(phaseIdToRangeKey('sessions')).toBe('sessions');
    expect(phaseIdToRangeKey('complete')).toBe('complete');
  });

  it('mapToPhaseRange returns a number clamped to the phase band', () => {
    expectTypeOf(mapToPhaseRange).returns.toBeNumber();
    expect(mapToPhaseRange('workspace', 0)).toBe(10);
    expect(mapToPhaseRange('workspace', 1)).toBe(22);
    // Out-of-band ratios are clamped rather than reflected outside the band.
    expect(mapToPhaseRange('workspace', 2)).toBe(22);
    expect(mapToPhaseRange('workspace', -1)).toBe(10);
  });

  // ---------------------------------------------------------------------------
  // FootprintOutcome discriminated union narrowing
  // ---------------------------------------------------------------------------

  it('FootprintOutcome narrows correctly on the `kind` discriminator', () => {
    const outcome: FootprintOutcome = {
      kind: 'measured_nonzero',
      totalBytes: 1_234_567,
      workspaceBytes: 1_000_000,
      appDataBytes: 234_567,
    };

    // Narrow via the discriminator.
    if (outcome.kind === 'measured_nonzero') {
      expectTypeOf(outcome.totalBytes).toBeNumber();
      expectTypeOf(outcome.appDataBytes).toBeNumber();
      expectTypeOf(outcome.workspaceBytes).toEqualTypeOf<number | undefined>();
      // Should NOT have `partialBytes` or `reason` fields.
      // @ts-expect-error — `partialBytes` is only on the `unknown_partial` variant.
      void outcome.partialBytes;
      // @ts-expect-error — `reason` is only on the `unknown_partial` variant.
      void outcome.reason;
    }

    const partial: FootprintOutcome = {
      kind: 'unknown_partial',
      partialBytes: 512,
      reason: 'timeout',
    };
    if (partial.kind === 'unknown_partial') {
      expectTypeOf(partial.partialBytes).toBeNumber();
      expectTypeOf(partial.reason).toEqualTypeOf<
        'timeout' | 'permission' | 'mount_error' | 'symlink_cycle'
      >();
      // @ts-expect-error — `totalBytes` is not on the `unknown_partial` variant.
      void partial.totalBytes;
    }

    const zero: FootprintOutcome = {
      kind: 'measured_zero',
      totalBytes: 0,
      workspaceBytes: 0,
      appDataBytes: 0,
    };
    if (zero.kind === 'measured_zero') {
      // `totalBytes` on this branch is literal `0` — a tighter shape than the
      // other branches, which is what the discriminated union intends.
      expectTypeOf(zero.totalBytes).toEqualTypeOf<0>();
      expectTypeOf(zero.workspaceBytes).toEqualTypeOf<0>();
    }
  });

  it('FootprintOutcome exhaustiveness — a switch covers every variant', () => {
    // If a new variant is added, this function will fail to compile because
    // `never` will become the union of the missing variants. That's the
    // intended drift detector.
    const describe = (o: FootprintOutcome): string => {
      switch (o.kind) {
        case 'measured_zero':
          return 'zero';
        case 'measured_nonzero':
          return 'non-zero';
        case 'unknown_partial':
          return 'partial';
        default: {
          const _exhaustive: never = o;
          return _exhaustive;
        }
      }
    };
    expect(
      describe({ kind: 'measured_zero', totalBytes: 0, workspaceBytes: 0, appDataBytes: 0 }),
    ).toBe('zero');
  });
});
