import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from 'react';

type DevProfilerProps = {
  id: string;
  children: ReactNode;
  thresholdMs?: number;
};

const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX_LOGS = 10;

type RateLimitState = {
  count: number;
  windowStart: number;
};

const rateLimitMap = new Map<string, RateLimitState>();
const renderCountMap = new Map<string, number>();

function shouldLog(id: string): boolean {
  const now = Date.now();
  const state = rateLimitMap.get(id);

  if (!state || now - state.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(id, { count: 1, windowStart: now });
    return true;
  }

  if (state.count >= RATE_LIMIT_MAX_LOGS) {
    return false;
  }

  state.count++;
  return true;
}

function incrementRenderCount(id: string): number {
  const count = (renderCountMap.get(id) ?? 0) + 1;
  renderCountMap.set(id, count);
  return count;
}

/**
 * Development-only React Profiler wrapper that logs render performance to the app log.
 *
 * In production builds, this component renders children directly with zero overhead
 * (the profiler code is tree-shaken out via import.meta.env.DEV check).
 *
 * Logs include:
 * - id: Component identifier
 * - phase: 'mount' | 'update' | 'nested-update'
 * - actualDuration: Time spent rendering this update (ms)
 * - baseDuration: Estimated time without memoization (ms)
 * - renderCount: Total renders since app start (for detecting render thrash)
 *
 * Rate limited to max 10 logs per component per 10 seconds to prevent log flood.
 *
 * @example
 * <DevProfiler id="ConversationPane">
 *   <ConversationPane {...props} />
 * </DevProfiler>
 *
 * @see docs/project/APP_PERFORMANCE_AND_MEMORY.md for interpretation guide
 */
export function DevProfiler({ id, children, thresholdMs = 16 }: DevProfilerProps) {
  // Only active in dev mode with VITE_PERFORMANCE=true (npm run dev:perf)
  if (!import.meta.env.DEV || import.meta.env.VITE_PERFORMANCE !== 'true') {
    return <>{children}</>;
  }

  return <DevProfilerInner id={id} thresholdMs={thresholdMs}>{children}</DevProfilerInner>;
}

function DevProfilerInner({ id, children, thresholdMs }: Required<Omit<DevProfilerProps, 'thresholdMs'>> & { thresholdMs: number }) {
  const onRender: ProfilerOnRenderCallback = (
    profilerId,
    phase,
    actualDuration,
    baseDuration,
    startTime,
    commitTime
  ) => {
    const renderCount = incrementRenderCount(profilerId);

    if (actualDuration < thresholdMs) {
      return;
    }

    if (!shouldLog(profilerId)) {
      return;
    }

    if (import.meta.env.VITE_PERFORMANCE === 'true') {
      console.warn(
        `[SWITCH-PERF-REACT] id=${profilerId} phase=${phase} ` +
        `actualMs=${actualDuration.toFixed(1)} baseMs=${baseDuration.toFixed(1)} ` +
        `renderCount=${renderCount} startMs=${startTime.toFixed(1)} commitMs=${commitTime.toFixed(1)}`,
      );
    }
  };

  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}
