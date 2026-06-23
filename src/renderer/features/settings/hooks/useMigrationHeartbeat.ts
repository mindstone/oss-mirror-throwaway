/**
 * useMigrationHeartbeat
 *
 * Tracks whether the cloud-migration progress stream looks healthy, stalled,
 * or silent based on the timings of incoming `MigrationStep` events.
 *
 * Three states are derived purely from clock deltas \u2014 the producer never
 * has to explicitly tell us "the connection is alive." If `current` (the
 * authoritative byte counter) keeps moving, we're healthy; if events keep
 * arriving but `current` doesn't advance, we're stalled; if events stop
 * entirely, we're silent.
 *
 * Thresholds (spec):
 *   - stalled          \u2014 > 15 s since `current` last changed, events still flowing
 *   - silent           \u2014 > 30 s since the last event of any kind arrived
 *   - prolongedStall   \u2014 > 5 min of no byte movement, used to escalate the
 *                       UI to "This is taking longer than expected"
 *
 * See planning doc:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 *   (Stage 7 \u2014 Renderer ETA + Heartbeat)
 *
 * Notes:
 *   - Timestamps are stored in `useRef` so they survive re-renders without
 *     re-triggering effects.
 *   - The hook samples the clock via a 1s `setInterval`; that's fine for
 *     15 s / 30 s / 5 min thresholds and avoids timer thrash on every
 *     incoming event. We re-evaluate eagerly on each new event too.
 *   - Non-live or completed steps reset the bookkeeping so the badge
 *     disappears once upload/extract is done.
 */

import { useEffect, useRef, useState } from 'react';
import type { MigrationStep } from '@shared/cloudMigrationTypes';

export const STALLED_THRESHOLD_MS = 15_000;
export const SILENT_THRESHOLD_MS = 30_000;
export const PROLONGED_STALL_THRESHOLD_MS = 5 * 60 * 1000;

/** Sampling cadence. 1 s is plenty for 15 s / 30 s / 5 min thresholds. */
const SAMPLE_INTERVAL_MS = 1_000;

export interface MigrationHeartbeat {
  /** > 15 s since `current` moved, but events keep arriving. */
  stalled: boolean;
  /** > 30 s since the last event of any kind. */
  silent: boolean;
  /** > 5 min of no byte movement. Used to surface "taking longer than expected". */
  prolongedStall: boolean;
}

interface HeartbeatClockDeps {
  /** Injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable sampling interval (ms). Defaults to `SAMPLE_INTERVAL_MS`. */
  sampleIntervalMs?: number;
}

const INITIAL_STATE: MigrationHeartbeat = {
  stalled: false,
  silent: false,
  prolongedStall: false,
};

/**
 * Track heartbeat state for a cloud migration run.
 *
 * Callers should render heartbeat-aware copy only while a live upload or
 * extract is in flight; passing `null` once the run completes clears the
 * bookkeeping.
 */
export function useMigrationHeartbeat(
  step: MigrationStep | null,
  deps: HeartbeatClockDeps = {},
): MigrationHeartbeat {
  const now = deps.now ?? Date.now;
  const sampleIntervalMs = deps.sampleIntervalMs ?? SAMPLE_INTERVAL_MS;

  // Refs survive re-renders without retriggering effects.
  const runIdRef = useRef<string | null>(null);
  const lastEventAtRef = useRef<number | null>(null);
  const lastCurrentValueRef = useRef<number | null>(null);
  const lastCurrentAtRef = useRef<number | null>(null);

  const [state, setState] = useState<MigrationHeartbeat>(INITIAL_STATE);

  function evaluate(nowMs: number): MigrationHeartbeat {
    const lastEventAt = lastEventAtRef.current;
    const lastCurrentAt = lastCurrentAtRef.current;
    // If we've never seen an event, everything is quiet \u2014 no alarms yet.
    if (lastEventAt == null || lastCurrentAt == null) return INITIAL_STATE;

    const sinceEvent = nowMs - lastEventAt;
    const sinceMovement = nowMs - lastCurrentAt;

    const silent = sinceEvent > SILENT_THRESHOLD_MS;
    // "Stalled" is specifically events-without-byte-movement; when we've also
    // gone silent, the UI should prefer the "silent" copy.
    const stalled = !silent && sinceMovement > STALLED_THRESHOLD_MS;
    const prolongedStall = sinceMovement > PROLONGED_STALL_THRESHOLD_MS;

    return { stalled, silent, prolongedStall };
  }

  // Update the refs on every incoming event and re-evaluate immediately.
  useEffect(() => {
    if (step == null) {
      runIdRef.current = null;
      lastEventAtRef.current = null;
      lastCurrentValueRef.current = null;
      lastCurrentAtRef.current = null;
      setState(INITIAL_STATE);
      return;
    }

    // A new run resets all bookkeeping \u2014 different run means different samples.
    const runId = step.runId ?? null;
    if (runId !== runIdRef.current) {
      runIdRef.current = runId;
      lastEventAtRef.current = null;
      lastCurrentValueRef.current = null;
      lastCurrentAtRef.current = null;
    }

    const nowMs = now();
    lastEventAtRef.current = nowMs;

    const curr = step.current;
    // Only reset the movement timer when the byte counter actually advances.
    // A stale event that repeats the same `current` should not mask a stall.
    if (curr != null && Number.isFinite(curr) && curr !== lastCurrentValueRef.current) {
      lastCurrentValueRef.current = curr;
      lastCurrentAtRef.current = nowMs;
    } else if (lastCurrentAtRef.current == null) {
      // First event for this run \u2014 seed the movement timestamp so the
      // stall clock starts now rather than immediately tripping.
      lastCurrentAtRef.current = nowMs;
    }

    setState(evaluate(nowMs));
    // `now` is stable enough to avoid a dependency; `setState` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: omitting now/evaluate because incoming step events, not injected clock identity, drive eager recalculation
  }, [step]);

  // Periodic re-evaluation covers the "no new events at all" case.
  useEffect(() => {
    if (step == null) return;
    const id = setInterval(() => {
      setState(evaluate(now()));
    }, sampleIntervalMs);
    return () => clearInterval(id);
    // Intentionally depend on `step` (not its contents) so we keep a single
    // interval alive across events for the same migration run. The effect
    // above already handles eager updates on event arrival.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: omitting now/evaluate so the sampling interval is not restarted by injected clock identity changes
  }, [step, sampleIntervalMs]);

  return state;
}
