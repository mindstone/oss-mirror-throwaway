// @vitest-environment happy-dom

/**
 * MigrationProgressBar \u2014 Stage 7 estimator + heartbeat integration.
 *
 * Renders the component against a sequence of `CloudMigrationProgress`
 * events and verifies:
 *
 *   1. Before the `ThroughputEstimator` has two samples spanning the
 *      minimum window span, the detail line is "Estimating..." \u2014 we never
 *      fabricate an ETA.
 *   2. Once samples accumulate, the detail line switches to the compact
 *      "3 min \u00b7 27% \u00b7 240/900 MB" shape.
 *   3. Heartbeat-driven states (stalled / silent / prolonged stall) render
 *      the correct calm copy.
 *   4. A new `runId` resets the estimator so stale samples from a previous
 *      run can't poison the new ETA.
 *   5. `current > total` is clamped so the bar never shows > 100%.
 *
 * See planning doc:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 *   (Stage 7 \u2014 Renderer: Real ETA + Bootstrap State + Heartbeat + substring\u2192live swap)
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CloudMigrationProgress } from '@shared/cloudMigrationTypes';
import { MigrationProgressBar } from '../CloudTab';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MB = 1024 * 1024;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  rerender: (step: CloudMigrationProgress) => void;
  unmount: () => void;
}

function mount(step: CloudMigrationProgress): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const render = (s: CloudMigrationProgress) => {
    act(() => {
      root.render(React.createElement(MigrationProgressBar, { step: s }));
    });
  };

  render(step);

  return {
    container,
    root,
    rerender: render,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function getDetail(container: HTMLElement): string {
  const el = container.querySelector('[data-testid="cloud-migration-progress-detail"]');
  return el?.textContent ?? '';
}

function getHeartbeatAttr(container: HTMLElement): string | null {
  const el = container.querySelector('[data-testid="cloud-migration-progress-bar"]');
  return el?.getAttribute('data-heartbeat') ?? null;
}

function getProgressFillWidth(container: HTMLElement): string | null {
  const outer = container.querySelector('[data-testid="cloud-migration-progress-bar"]');
  const fill = outer?.querySelector('div > div > div');
  // Fallback: second div (progress track) contains the fill.
  const tracks = outer?.querySelectorAll('div');
  if (tracks && tracks.length >= 3) {
    // outer children order: [label row], [track > fill], [detail row]
    const trackFill = tracks[1]?.firstElementChild as HTMLElement | undefined;
    if (trackFill) return trackFill.style.width;
  }
  return fill instanceof HTMLElement ? fill.style.width : null;
}

function makeStep(overrides: Partial<CloudMigrationProgress> = {}): CloudMigrationProgress {
  return {
    phase: 'workspace',
    message: 'Uploading workspace...',
    progress: 10,
    current: 0,
    total: 900 * MB,
    bytesTotal: 900 * MB,
    live: true,
    runId: 'run-A',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MigrationProgressBar (Stage 7 estimator + heartbeat)', () => {
  let mounted: Mounted | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T00:00:00.000Z'));
    mounted = null;
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('shows "Estimating..." before the ThroughputEstimator has enough samples', () => {
    mounted = mount(makeStep({ progress: 10, current: 0 }));
    expect(getDetail(mounted.container)).toBe('Uploading workspace... Estimating...');
    expect(getHeartbeatAttr(mounted.container)).toBe('active');
  });

  it('falls back to static phase copy when the producer is not reporting live detail', () => {
    mounted = mount(makeStep({
      live: false,
      message: 'whatever',
      // Non-workspace phase with no live detail \u2014 should show the phase blurb.
      phase: 'sessions',
      current: 3,
      total: 10,
    }));
    // Static blurb from PHASE_COPY.sessions.
    expect(getDetail(mounted.container)).toContain('Every conversation');
  });

  it('renders the "3 min \u00b7 27% \u00b7 240/900 MB" shape once enough samples have accumulated', () => {
    // First event at T+0 with 0 bytes.
    mounted = mount(makeStep({ progress: 10, current: 0 }));
    expect(getDetail(mounted.container)).toBe('Uploading workspace... Estimating...');

    // Advance the real clock so `ThroughputEstimator.addSample(bytes)` timestamps
    // the next sample far enough ahead of the first that the rolling-window
    // slope is computable. We use 3s + 240 MB so the implied rate is 80 MB/s
    // and the remaining (900 \u2212 240) MB \u2248 8.25s ETA. That formats to "9s".
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    mounted.rerender(makeStep({ progress: 27, current: 240 * MB }));

    const detail = getDetail(mounted.container);
    // Shape: "{eta} \u00b7 {pct}% \u00b7 {used}/{total} MB"
    expect(detail).toMatch(/^\S+\s\u00b7\s27%\s\u00b7\s240 MB\/900 MB$/);
  });

  it('swaps to "checking connection" copy when stalled (>15 s without byte movement)', () => {
    mounted = mount(makeStep({ progress: 10, current: 0 }));

    // Same `current` repeated after 16 s \u2014 heartbeat flips to stalled.
    act(() => {
      vi.advanceTimersByTime(16_000);
    });
    mounted.rerender(makeStep({ progress: 10, current: 0, message: 'Still uploading...' }));

    const detail = getDetail(mounted.container);
    expect(detail).toContain('Still uploading...');
    expect(detail).toContain('checking connection');
    expect(getHeartbeatAttr(mounted.container)).toBe('stalled');
  });

  it('swaps to "Upload paused" copy when the event stream goes silent (>30 s)', () => {
    mounted = mount(makeStep({ progress: 10, current: 0 }));

    // Don't re-render, just let time advance past the silent threshold.
    act(() => {
      vi.advanceTimersByTime(31_000);
    });

    expect(getDetail(mounted.container)).toContain('Upload paused');
    expect(getHeartbeatAttr(mounted.container)).toBe('silent');
  });

  it('creates a new estimator when the runId changes (reset across runs)', () => {
    // First run accumulates samples.
    mounted = mount(makeStep({ runId: 'run-A', progress: 10, current: 0 }));
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    mounted.rerender(makeStep({ runId: 'run-A', progress: 27, current: 240 * MB }));
    // Sanity: we're out of bootstrap for run-A.
    expect(getDetail(mounted.container)).not.toContain('Estimating...');

    // New run \u2014 estimator should reset and we're back in bootstrap.
    mounted.rerender(makeStep({ runId: 'run-B', progress: 1, current: 0 }));
    expect(getDetail(mounted.container)).toBe('Uploading workspace... Estimating...');
  });

  it('clamps current > total so the bar never exceeds 100%', () => {
    // Simulate the tar overhead overshoot: current reports slightly more than
    // total. Progress has already been clamped to 100 by the producer; we
    // additionally verify the renderer itself does not blow past 100.
    mounted = mount(makeStep({
      progress: 102,              // deliberately over 100
      current: 1_100 * MB,        // deliberately > total
      total: 1_000 * MB,
    }));

    const width = getProgressFillWidth(mounted.container);
    expect(width).toBe('100%');

    // Percentage text in the label row is rounded and clamped too.
    const percentageText = mounted.container.querySelector(
      '[data-testid="cloud-migration-progress-bar"] > div > span:last-child',
    )?.textContent ?? '';
    expect(percentageText.trim()).toBe('100%');
  });
});
