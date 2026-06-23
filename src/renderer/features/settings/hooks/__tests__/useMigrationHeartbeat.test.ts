// @vitest-environment happy-dom

/**
 * useMigrationHeartbeat behaviour tests.
 *
 * Uses Vitest fake timers and an injected clock so the 15 s / 30 s / 5 min
 * thresholds are exercised deterministically without waiting in real time.
 * Pattern mirrors the other renderer-hook tests in this folder
 * (react-dom/client + `act` + `React.createElement` \u2014 the repo has no
 * `@testing-library/react`).
 *
 * See planning doc:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 *   (Stage 7 \u2014 Renderer ETA + Heartbeat)
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MigrationStep } from '@shared/cloudMigrationTypes';
import {
  PROLONGED_STALL_THRESHOLD_MS,
  SILENT_THRESHOLD_MS,
  STALLED_THRESHOLD_MS,
  useMigrationHeartbeat,
  type MigrationHeartbeat,
} from '../useMigrationHeartbeat';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Test host. Mutates the caller's `resultRef.current` on every render so the
// test can assert on the hook's return value. Step input is threaded via
// props so we can simulate "new event arrives" by re-rendering.
// ---------------------------------------------------------------------------

interface HostProps {
  step: MigrationStep | null;
  now: () => number;
  sampleIntervalMs: number;
  resultRef: { current: MigrationHeartbeat };
}

const Host: React.FC<HostProps> = ({ step, now, sampleIntervalMs, resultRef }) => {
  const hb = useMigrationHeartbeat(step, { now, sampleIntervalMs });
  resultRef.current = hb;
  return null;
};

interface Mounted {
  result: { current: MigrationHeartbeat };
  rerender: (step: MigrationStep | null) => void;
  unmount: () => void;
}

function mountHost(
  initialStep: MigrationStep | null,
  clock: { now: () => number },
): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const result = {
    current: { stalled: false, silent: false, prolongedStall: false } as MigrationHeartbeat,
  };

  const render = (step: MigrationStep | null) => {
    act(() => {
      root.render(
        React.createElement(Host, {
          step,
          now: clock.now,
          sampleIntervalMs: 1_000,
          resultRef: result,
        }),
      );
    });
  };

  render(initialStep);

  return {
    result,
    rerender: render,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function makeStep(overrides: Partial<MigrationStep> = {}): MigrationStep {
  return {
    phase: 'workspace',
    message: 'Uploading workspace...',
    progress: 15,
    current: 0,
    total: 900 * 1024 * 1024,
    live: true,
    runId: 'run-1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useMigrationHeartbeat', () => {
  let mounted: Mounted | null = null;
  let currentNow = 0;
  const clock = { now: () => currentNow };

  function advance(ms: number) {
    currentNow += ms;
    vi.advanceTimersByTime(ms);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    currentNow = 1_000_000; // arbitrary non-zero epoch
    mounted = null;
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('returns the healthy idle state before any step arrives', () => {
    mounted = mountHost(null, clock);
    expect(mounted.result.current).toEqual({
      stalled: false,
      silent: false,
      prolongedStall: false,
    });
  });

  it('stays healthy while `current` advances within the stall threshold', () => {
    mounted = mountHost(makeStep({ current: 0 }), clock);
    expect(mounted.result.current.stalled).toBe(false);
    expect(mounted.result.current.silent).toBe(false);

    act(() => {
      advance(5_000);
    });
    mounted.rerender(makeStep({ current: 10 * 1024 * 1024 }));

    expect(mounted.result.current.stalled).toBe(false);
    expect(mounted.result.current.silent).toBe(false);
    expect(mounted.result.current.prolongedStall).toBe(false);
  });

  it('reports `stalled` at 16 s since the last byte-movement event', () => {
    mounted = mountHost(makeStep({ current: 0 }), clock);

    // Event arrives at T+8s with `current` unchanged.
    act(() => {
      advance(8_000);
    });
    mounted.rerender(makeStep({ current: 0, message: 'Still uploading...' }));
    expect(mounted.result.current.stalled).toBe(false);

    // Another event arrives at T+16s with `current` still unchanged.
    act(() => {
      advance(8_000);
    });
    mounted.rerender(makeStep({ current: 0, message: 'Still uploading...' }));

    expect(mounted.result.current.stalled).toBe(true);
    expect(mounted.result.current.silent).toBe(false);
    expect(mounted.result.current.prolongedStall).toBe(false);
  });

  it('reports `silent` at 31 s since the last event', () => {
    mounted = mountHost(makeStep({ current: 10 }), clock);

    // No new events in this window \u2014 the periodic sampler drives the update.
    act(() => {
      advance(SILENT_THRESHOLD_MS + 1_000);
    });

    expect(mounted.result.current.silent).toBe(true);
    // When silent, stalled is suppressed so the UI shows the more cautious
    // "silent" copy rather than doubling up.
    expect(mounted.result.current.stalled).toBe(false);
  });

  it('reports `prolongedStall` after 5 min of no movement', () => {
    mounted = mountHost(makeStep({ current: 0 }), clock);

    act(() => {
      advance(PROLONGED_STALL_THRESHOLD_MS + 1_000);
    });

    expect(mounted.result.current.prolongedStall).toBe(true);
  });

  it('clears `stalled` as soon as `current` advances again', () => {
    mounted = mountHost(makeStep({ current: 0 }), clock);

    act(() => {
      advance(STALLED_THRESHOLD_MS + 2_000);
    });
    expect(
      mounted.result.current.stalled || mounted.result.current.silent,
    ).toBe(true);

    // Fresh event with advanced `current` \u2014 heartbeat resumes.
    mounted.rerender(makeStep({ current: 42 * 1024 * 1024, message: 'Uploading...' }));

    expect(mounted.result.current.stalled).toBe(false);
    expect(mounted.result.current.silent).toBe(false);
  });

  it('resets bookkeeping when the `runId` changes (new migration run)', () => {
    mounted = mountHost(makeStep({ runId: 'run-A', current: 0 }), clock);

    act(() => {
      advance(STALLED_THRESHOLD_MS + 5_000);
    });
    expect(
      mounted.result.current.stalled || mounted.result.current.silent,
    ).toBe(true);

    // A different migration starts \u2014 stalls from the old one must not leak.
    mounted.rerender(makeStep({ runId: 'run-B', current: 100 }));

    expect(mounted.result.current.stalled).toBe(false);
    expect(mounted.result.current.silent).toBe(false);
    expect(mounted.result.current.prolongedStall).toBe(false);
  });
});
