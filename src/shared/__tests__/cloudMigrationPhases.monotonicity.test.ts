/**
 * Stage 8 — Migration phase-range monotonicity.
 *
 * `MIGRATION_PHASE_RANGES` is the single source of truth for the 0–100%
 * sub-bands that each phase occupies. The progress bar derives its
 * rendered percentage from a `ratio01` mapped into the current phase's
 * band, so the bands MUST:
 *   - each have `min < max`
 *   - be strictly non-overlapping in order
 *   - end at `complete.max === 100`
 *
 * And when a migration event sequence walks through the phases
 * (settings → mcp → workspace → extract → appdata → sessions → complete),
 * the resulting `progress` values MUST be monotonically non-decreasing so
 * the UI never flashes backwards.
 *
 * Stage 6 introduced the `extract` band (22–30) after Stage 5 shrank
 * `workspace` from 10–30 to 10–22; this test is the regression net that
 * guarantees future phase-band reshuffles don't silently re-introduce the
 * collision.
 *
 * See planning doc:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 *   (Review-Driven Amendments → Cross-cutting: Progress Range Constants)
 */

import { describe, it, expect } from 'vitest';
import {
  MIGRATION_PHASE_RANGES,
  mapToPhaseRange,
  phaseIdToRangeKey,
  type MigrationPhase,
} from '@shared/cloudMigrationPhases';
import type { MigrationPhaseId } from '@shared/cloudMigrationTypes';

// Ordered phase keys matching the producer's actual emission order. This is
// the authoritative sequence the progress bar walks through; if the order
// ever changes, the test fixture must change too.
const PHASE_ORDER: readonly MigrationPhase[] = [
  'settings',
  'mcp',
  'workspace',
  'extract',
  'appdata',
  'sessions',
  'complete',
] as const;

describe('MIGRATION_PHASE_RANGES monotonicity', () => {
  it('every phase has min < max', () => {
    for (const phase of PHASE_ORDER) {
      const { min, max } = MIGRATION_PHASE_RANGES[phase];
      expect(min, `${phase}.min < ${phase}.max`).toBeLessThan(max);
    }
  });

  it('phases are non-overlapping in the declared order', () => {
    for (let i = 0; i + 1 < PHASE_ORDER.length; i++) {
      const curr = PHASE_ORDER[i];
      const next = PHASE_ORDER[i + 1];
      const currMax = MIGRATION_PHASE_RANGES[curr].max;
      const nextMin = MIGRATION_PHASE_RANGES[next].min;
      expect(
        currMax,
        `${curr}.max (${currMax}) <= ${next}.min (${nextMin})`,
      ).toBeLessThanOrEqual(nextMin);
    }
  });

  it('explicitly asserts the documented boundaries', () => {
    // Spelled-out checks that trip if anyone edits the constants without
    // updating the plan's contract.
    expect(MIGRATION_PHASE_RANGES.settings.max).toBeLessThanOrEqual(
      MIGRATION_PHASE_RANGES.mcp.min,
    );
    expect(MIGRATION_PHASE_RANGES.mcp.max).toBeLessThanOrEqual(
      MIGRATION_PHASE_RANGES.workspace.min,
    );
    expect(MIGRATION_PHASE_RANGES.workspace.max).toBeLessThanOrEqual(
      MIGRATION_PHASE_RANGES.extract.min,
    );
    expect(MIGRATION_PHASE_RANGES.extract.max).toBeLessThanOrEqual(
      MIGRATION_PHASE_RANGES.appdata.min,
    );
    expect(MIGRATION_PHASE_RANGES.appdata.max).toBeLessThanOrEqual(
      MIGRATION_PHASE_RANGES.sessions.min,
    );
    expect(MIGRATION_PHASE_RANGES.sessions.max).toBeLessThanOrEqual(
      MIGRATION_PHASE_RANGES.complete.min,
    );
  });

  it('ends at exactly 100', () => {
    expect(MIGRATION_PHASE_RANGES.complete.max).toBe(100);
  });

  it('starts at exactly 0', () => {
    expect(MIGRATION_PHASE_RANGES.settings.min).toBe(0);
  });
});

describe('migration event sequence produces monotonic progress', () => {
  /**
   * Models the producer's real emission pattern: for each phase, emit a
   * "start-of-band" event at `min` and then progressively ramp to `max`.
   * The `extract` and `workspace` bands use multiple samples to simulate
   * live byte-based progress (uncompressed bytes → ratio → phase range).
   */
  function simulatePhaseSequence(): Array<{
    phase: MigrationPhase;
    eventPhase: MigrationPhaseId;
    progress: number;
  }> {
    const events: Array<{
      phase: MigrationPhase;
      eventPhase: MigrationPhaseId;
      progress: number;
    }> = [];

    // settings: 0 → 5
    events.push({ phase: 'settings', eventPhase: 'settings', progress: 0 });
    events.push({ phase: 'settings', eventPhase: 'settings', progress: 5 });

    // mcp: 5 → 10
    events.push({ phase: 'mcp', eventPhase: 'mcp-config', progress: 5 });
    events.push({ phase: 'mcp', eventPhase: 'mcp-config', progress: 10 });

    // workspace: 10 → 22, with a ramp simulating live upload
    for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
      events.push({
        phase: 'workspace',
        eventPhase: 'workspace',
        progress: mapToPhaseRange('workspace', ratio),
      });
    }

    // extract: 22 → 30, also a ramp
    for (const ratio of [0, 0.5, 1]) {
      events.push({
        phase: 'extract',
        eventPhase: 'extract',
        progress: mapToPhaseRange('extract', ratio),
      });
    }

    // appdata: 30 → 45
    events.push({ phase: 'appdata', eventPhase: 'app-data', progress: 30 });
    events.push({ phase: 'appdata', eventPhase: 'app-data', progress: 45 });

    // sessions: 45 → 95
    events.push({ phase: 'sessions', eventPhase: 'sessions', progress: 45 });
    events.push({ phase: 'sessions', eventPhase: 'sessions', progress: 95 });

    // complete: 95 → 100
    events.push({ phase: 'complete', eventPhase: 'complete', progress: 95 });
    events.push({ phase: 'complete', eventPhase: 'complete', progress: 100 });

    return events;
  }

  it('a simulated end-to-end run emits strictly non-decreasing progress', () => {
    const sequence = simulatePhaseSequence();
    for (let i = 1; i < sequence.length; i++) {
      const prev = sequence[i - 1];
      const curr = sequence[i];
      expect(
        curr.progress,
        `event ${i} (${curr.phase}/${curr.progress}) must be >= prev ${prev.phase}/${prev.progress}`,
      ).toBeGreaterThanOrEqual(prev.progress);
    }
  });

  it('event phase ids map into the expected range keys', () => {
    const sequence = simulatePhaseSequence();
    for (const ev of sequence) {
      expect(phaseIdToRangeKey(ev.eventPhase)).toBe(ev.phase);
    }
  });

  it('every event lies within its phase band (no band escape)', () => {
    const sequence = simulatePhaseSequence();
    for (const ev of sequence) {
      const { min, max } = MIGRATION_PHASE_RANGES[ev.phase];
      expect(ev.progress).toBeGreaterThanOrEqual(min);
      expect(ev.progress).toBeLessThanOrEqual(max);
    }
  });
});
