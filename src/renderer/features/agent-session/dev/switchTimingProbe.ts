import { scrubAttribution } from '@renderer/hooks/performanceMonitor/scrubAttribution';

type SpanOutcome = 'reveal' | 'aborted' | 'superseded' | 'cancelled' | 'failed';

export interface PrimitiveDiagnostics {
  primTotalMs: number;
  msToFirstTerminalRow: number | null;
  msToFirstAtBottomGeometry: number | null;
  msToFirstStableFrame: number | null;
  msToHoldStart: number | null;
  finalHoldMs: number | null;
  maxFrameGapMs: number;
  framesOverGapThreshold: number;
  resetsGeometryGap: number;
  resetsTerminalRowMissing: number;
  resetsQuiescenceFailed: number;
  resetsResumedFromBlock: number;
  activityScrollHeightChanges: number;
  activityVirtualizerOnChange: number;
  finalMessageCount: number;
  finalTerminalIndex: number;
}

interface SwitchTimingSpan {
  sessionId: string;
  clickAt: number;
  engineOpenDoneAt?: number;
  primitiveStartAt?: number;
  primitiveResolvedAt?: number;
  wasCacheHit?: boolean;
  primitiveReason?: string;
  landedAtBottom?: boolean;
  primitiveDiagnostics?: PrimitiveDiagnostics;
}

let currentSpan: SwitchTimingSpan | null = null;
let pendingPaintMark:
  | { sessionId: string; revealAt: number; clickAt: number }
  | null = null;

const isEnabled = (): boolean => import.meta.env.VITE_PERFORMANCE === 'true';

const fmt = (a: number | undefined, b: number | undefined): string =>
  a != null && b != null ? `${(b - a).toFixed(1)}ms` : '–';

const fmtMs = (v: number | null | undefined): string =>
  v == null ? '–' : v.toFixed(1);

function safeNow(): number | null {
  try {
    return performance.now();
  } catch {
    return null;
  }
}

function safeWarn(message: string): void {
  try {
    console.warn(message);
  } catch {
    // Instrumentation must never affect navigation, even in dev:perf.
  }
}

function formatPrimDiagnosticsLine(
  sessionId: string,
  d: PrimitiveDiagnostics,
): string {
  return (
    `[SWITCH-PERF-PRIM] sessionId=${sessionId.slice(0, 8)} ` +
    `primMs=${d.primTotalMs.toFixed(1)} ` +
    `firstRowMs=${fmtMs(d.msToFirstTerminalRow)} ` +
    `firstAtBottomMs=${fmtMs(d.msToFirstAtBottomGeometry)} ` +
    `firstStableMs=${fmtMs(d.msToFirstStableFrame)} ` +
    `holdStartMs=${fmtMs(d.msToHoldStart)} ` +
    `holdMs=${fmtMs(d.finalHoldMs)} ` +
    `maxGapMs=${d.maxFrameGapMs.toFixed(1)} ` +
    `longFrames=${d.framesOverGapThreshold} ` +
    `messages=${d.finalMessageCount} termIdx=${d.finalTerminalIndex} ` +
    `resetsGeom=${d.resetsGeometryGap} ` +
    `resetsNoTermRow=${d.resetsTerminalRowMissing} ` +
    `resetsQuiesc=${d.resetsQuiescenceFailed} ` +
    `resetsLongTask=${d.resetsResumedFromBlock} ` +
    `activityHeight=${d.activityScrollHeightChanges} ` +
    `activityOnChange=${d.activityVirtualizerOnChange}`
  );
}

// ── Switch-scoped long-task attribution ─────────────────────────────
//
// A single module-level PerformanceObserver collects `longtask` entries
// while perf mode is enabled. At each span boundary (paint for revealed
// switches, abandon for non-revealed) we filter the buffer for entries
// that overlap `[clickAt, now]` and emit one `[SWITCH-PERF-LONG]` line.
//
// Fail-closed: if `PerformanceObserver` is missing or `longtask` is
// unsupported, we leave the observer null and skip emission. The probe
// must never affect navigation.

interface LongTaskRecord {
  startTime: number;
  duration: number;
  attribLabel: string | null;
}

interface LoafRecord {
  startTime: number;
  duration: number;
  blockingDuration: number | null;
  forcedStyleAndLayoutDuration: number | null;
  scripts: string[];
}

const LONG_TASK_BUFFER_CAP = 200;
const TOP_ATTRIB_COUNT = 3;

const longTaskBuffer: LongTaskRecord[] = [];
const loafBuffer: LoafRecord[] = [];
let longTaskObserver: PerformanceObserver | null = null;
let longTaskObserverInstallAttempted = false;
let loafObserver: PerformanceObserver | null = null;
let loafObserverInstallAttempted = false;

function attribLabelFor(entry: PerformanceEntry): string | null {
  try {
    const scrubbed = scrubAttribution(entry);
    return scrubbed.labelPath != null
      ? `${scrubbed.category}(${scrubbed.labelPath})`
      : scrubbed.category;
  } catch {
    return null;
  }
}

function pushLongTaskEntry(entry: PerformanceEntry): void {
  const startTime = (entry as { startTime?: number }).startTime;
  const duration = (entry as { duration?: number }).duration;
  if (typeof startTime !== 'number' || typeof duration !== 'number') return;
  longTaskBuffer.push({
    startTime,
    duration,
    attribLabel: attribLabelFor(entry),
  });
  if (longTaskBuffer.length > LONG_TASK_BUFFER_CAP) {
    longTaskBuffer.splice(0, longTaskBuffer.length - LONG_TASK_BUFFER_CAP);
  }
}

function scrubLoafScriptLabel(script: unknown): string {
  const s = script as {
    sourceURL?: string;
    sourceFunctionName?: string;
    invoker?: string;
  };
  const rawUrl = typeof s.sourceURL === 'string' ? s.sourceURL : '';
  const file = rawUrl
    .split('?')[0]
    ?.split('/')
    .filter(Boolean)
    .slice(-2)
    .join('/') || 'self';
  const fn =
    typeof s.sourceFunctionName === 'string' && s.sourceFunctionName
      ? s.sourceFunctionName
      : typeof s.invoker === 'string' && s.invoker
        ? s.invoker
        : '';
  const compact = fn ? `${file}:${fn}` : file;
  return compact
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>')
    .replace(/[a-f0-9]{16,}/gi, '<id>')
    .slice(0, 120);
}

function pushLoafEntry(entry: PerformanceEntry): void {
  const e = entry as PerformanceEntry & {
    blockingDuration?: number;
    forcedStyleAndLayoutDuration?: number;
    scripts?: unknown[];
  };
  const startTime = e.startTime;
  const duration = e.duration;
  if (typeof startTime !== 'number' || typeof duration !== 'number') return;
  loafBuffer.push({
    startTime,
    duration,
    blockingDuration:
      typeof e.blockingDuration === 'number' ? e.blockingDuration : null,
    forcedStyleAndLayoutDuration:
      typeof e.forcedStyleAndLayoutDuration === 'number'
        ? e.forcedStyleAndLayoutDuration
        : null,
    scripts: Array.isArray(e.scripts)
      ? e.scripts.slice(0, 5).map(scrubLoafScriptLabel)
      : [],
  });
  if (loafBuffer.length > LONG_TASK_BUFFER_CAP) {
    loafBuffer.splice(0, loafBuffer.length - LONG_TASK_BUFFER_CAP);
  }
}

function installLongTaskObserverOnce(): void {
  if (longTaskObserverInstallAttempted) return;
  longTaskObserverInstallAttempted = true;
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    const observer = new PerformanceObserver((list) => {
      try {
        for (const entry of list.getEntries()) {
          pushLongTaskEntry(entry);
        }
      } catch {
        // Observer callback must never raise into the runtime.
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
    longTaskObserver = observer;
  } catch {
    // `longtask` entryType unsupported on this platform (e.g. Node, Safari).
    // Leave attempted=true so we don't retry on every span.
    longTaskObserver = null;
  }
}

function installLoafObserverOnce(): void {
  if (loafObserverInstallAttempted) return;
  loafObserverInstallAttempted = true;
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    const supported = (
      PerformanceObserver as unknown as { supportedEntryTypes?: string[] }
    ).supportedEntryTypes;
    if (Array.isArray(supported) && !supported.includes('long-animation-frame')) {
      return;
    }
    const observer = new PerformanceObserver((list) => {
      try {
        for (const entry of list.getEntries()) {
          pushLoafEntry(entry);
        }
      } catch {
        // Observer callback must never raise into the runtime.
      }
    });
    observer.observe({ type: 'long-animation-frame', buffered: true });
    loafObserver = observer;
  } catch {
    loafObserver = null;
  }
}

function flushPendingLongTasks(): void {
  const observer = longTaskObserver;
  if (!observer) return;
  try {
    const queued = observer.takeRecords();
    for (const entry of queued) pushLongTaskEntry(entry);
  } catch {
    // takeRecords can theoretically throw post-disconnect; ignore.
  }
}

function flushPendingLoafs(): void {
  const observer = loafObserver;
  if (!observer) return;
  try {
    const queued = observer.takeRecords();
    for (const entry of queued) pushLoafEntry(entry);
  } catch {
    // takeRecords can theoretically throw post-disconnect; ignore.
  }
}

function summarizeTopLabels(labels: string[]): string {
  if (labels.length === 0) return '–';
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_ATTRIB_COUNT)
    .map(([label, c]) => `${label}×${c}`)
    .join(',');
}

function emitLongTasksLine(
  sessionId: string,
  windowStart: number,
  windowEnd: number,
): void {
  flushPendingLongTasks();
  if (longTaskBuffer.length === 0) return;
  if (windowEnd <= windowStart) return;

  let count = 0;
  let sumMs = 0;
  let maxMs = 0;
  let overlapMs = 0;
  let firstStartRelMs: number | null = null;
  const attribCounts = new Map<string, number>();

  for (const r of longTaskBuffer) {
    const entryEnd = r.startTime + r.duration;
    if (entryEnd <= windowStart) continue;
    if (r.startTime >= windowEnd) continue;
    count += 1;
    sumMs += r.duration;
    if (r.duration > maxMs) maxMs = r.duration;
    const overlapStart = r.startTime > windowStart ? r.startTime : windowStart;
    const overlapEnd = entryEnd < windowEnd ? entryEnd : windowEnd;
    overlapMs += overlapEnd - overlapStart;
    const relStart = r.startTime - windowStart;
    if (firstStartRelMs == null || relStart < firstStartRelMs) {
      firstStartRelMs = relStart;
    }
    if (r.attribLabel) {
      attribCounts.set(
        r.attribLabel,
        (attribCounts.get(r.attribLabel) ?? 0) + 1,
      );
    }
  }

  if (count === 0) return;

  const topAttribs = Array.from(attribCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_ATTRIB_COUNT)
    .map(([label, c]) => `${label}×${c}`);
  const attribStr = topAttribs.length > 0 ? topAttribs.join(',') : '–';
  const firstStartStr =
    firstStartRelMs == null ? '–' : firstStartRelMs.toFixed(1);

  safeWarn(
    `[SWITCH-PERF-LONG] sessionId=${sessionId.slice(0, 8)} ` +
      `count=${count} ` +
      `sumMs=${sumMs.toFixed(1)} ` +
      `maxMs=${maxMs.toFixed(1)} ` +
      `overlapMs=${overlapMs.toFixed(1)} ` +
      `firstStartMs=${firstStartStr} ` +
      `attribs=${attribStr}`,
  );
}

function emitLoafLine(
  sessionId: string,
  windowStart: number,
  windowEnd: number,
): void {
  flushPendingLoafs();
  if (loafBuffer.length === 0 || windowEnd <= windowStart) return;

  let count = 0;
  let sumMs = 0;
  let maxMs = 0;
  let blockingMs = 0;
  let forcedStyleMs = 0;
  let firstStartRelMs: number | null = null;
  const scriptLabels: string[] = [];

  for (const r of loafBuffer) {
    const entryEnd = r.startTime + r.duration;
    if (entryEnd <= windowStart || r.startTime >= windowEnd) continue;
    count += 1;
    sumMs += r.duration;
    if (r.duration > maxMs) maxMs = r.duration;
    if (r.blockingDuration != null) blockingMs += r.blockingDuration;
    if (r.forcedStyleAndLayoutDuration != null) {
      forcedStyleMs += r.forcedStyleAndLayoutDuration;
    }
    const relStart = r.startTime - windowStart;
    if (firstStartRelMs == null || relStart < firstStartRelMs) {
      firstStartRelMs = relStart;
    }
    scriptLabels.push(...r.scripts);
  }

  if (count === 0) return;
  safeWarn(
    `[SWITCH-PERF-LOAF] sessionId=${sessionId.slice(0, 8)} ` +
      `count=${count} sumMs=${sumMs.toFixed(1)} maxMs=${maxMs.toFixed(1)} ` +
      `blockingMs=${blockingMs.toFixed(1)} forcedStyleMs=${forcedStyleMs.toFixed(1)} ` +
      `firstStartMs=${firstStartRelMs == null ? '–' : firstStartRelMs.toFixed(1)} ` +
      `scripts=${summarizeTopLabels(scriptLabels)}`,
  );
}

function emit(span: SwitchTimingSpan, outcome: SpanOutcome): void {
  const now = safeNow();
  if (now == null) return;
  const total = (now - span.clickAt).toFixed(1);
  const cache =
    span.wasCacheHit === undefined ? '?' : span.wasCacheHit ? 'HIT' : 'MISS';
  safeWarn(
    `[SWITCH-PERF] outcome=${outcome} sessionId=${span.sessionId.slice(0, 8)} cache=${cache} | ` +
      `click→engineDone=${fmt(span.clickAt, span.engineOpenDoneAt)} ` +
      `engineDone→primStart=${fmt(span.engineOpenDoneAt, span.primitiveStartAt)} ` +
      `primStart→primDone=${fmt(span.primitiveStartAt, span.primitiveResolvedAt)} ` +
      `primDone→end=${fmt(span.primitiveResolvedAt, now)} | ` +
      `total=${total}ms primReason=${span.primitiveReason ?? '–'} landed=${
        span.landedAtBottom === undefined ? '–' : String(span.landedAtBottom)
      }`,
  );
  if (span.primitiveDiagnostics) {
    safeWarn(formatPrimDiagnosticsLine(span.sessionId, span.primitiveDiagnostics));
  }
  // For non-reveal outcomes the span ends here and there is no paint mark
  // to wait for, so attribute long tasks immediately. Reveal outcomes defer
  // emission to `markPaintAfterReveal` so the LONG window spans click → paint.
  if (outcome !== 'reveal') {
    emitLongTasksLine(span.sessionId, span.clickAt, now);
    emitLoafLine(span.sessionId, span.clickAt, now);
  }
}

export function beginSwitchTiming(sessionId: string): void {
  if (!isEnabled()) return;
  installLongTaskObserverOnce();
  installLoafObserverOnce();
  if (currentSpan) emit(currentSpan, 'superseded');
  if (pendingPaintMark?.sessionId === sessionId) pendingPaintMark = null;
  const clickAt = safeNow();
  if (clickAt == null) {
    currentSpan = null;
    return;
  }
  currentSpan = { sessionId, clickAt };
}

export function markEngineOpenDone(
  sessionId: string,
  meta?: { wasCacheHit?: boolean },
): void {
  if (!isEnabled() || !currentSpan || currentSpan.sessionId !== sessionId) return;
  const now = safeNow();
  if (now == null) return;
  currentSpan.engineOpenDoneAt = now;
  if (meta?.wasCacheHit !== undefined) currentSpan.wasCacheHit = meta.wasCacheHit;
}

export function markPrimitiveStart(sessionId: string): void {
  if (!isEnabled() || !currentSpan || currentSpan.sessionId !== sessionId) return;
  const now = safeNow();
  if (now == null) return;
  currentSpan.primitiveStartAt = now;
  currentSpan.primitiveResolvedAt = undefined;
  currentSpan.primitiveReason = undefined;
  currentSpan.landedAtBottom = undefined;
  currentSpan.primitiveDiagnostics = undefined;
}

export function markPrimitiveResolved(
  sessionId: string,
  reason: string,
  landedAtBottom: boolean,
  diagnostics?: PrimitiveDiagnostics,
): void {
  if (!isEnabled() || !currentSpan || currentSpan.sessionId !== sessionId) return;
  const now = safeNow();
  if (now == null) return;
  currentSpan.primitiveResolvedAt = now;
  currentSpan.primitiveReason = reason;
  currentSpan.landedAtBottom = landedAtBottom;
  if (diagnostics) currentSpan.primitiveDiagnostics = diagnostics;
}

export function finishSwitchTiming(sessionId: string): void {
  if (!isEnabled() || !currentSpan || currentSpan.sessionId !== sessionId) return;
  const clickAt = currentSpan.clickAt;
  emit(currentSpan, 'reveal');
  const revealAt = safeNow();
  pendingPaintMark =
    revealAt == null ? null : { sessionId, revealAt, clickAt };
  currentSpan = null;
}

export function abandonSwitchTimingIfMatches(
  sessionId: string,
  outcome: 'cancelled' | 'failed' | 'aborted',
): void {
  if (!isEnabled() || !currentSpan || currentSpan.sessionId !== sessionId) return;
  emit(currentSpan, outcome);
  currentSpan = null;
}

export function markPaintAfterReveal(sessionId: string): void {
  if (!isEnabled()) return;
  if (!pendingPaintMark || pendingPaintMark.sessionId !== sessionId) return;
  const now = safeNow();
  if (now == null) return;
  // LONG covers the full click→paint window so the operator can see every
  // main-thread stall the user perceived; emit it just before PAINT.
  emitLongTasksLine(sessionId, pendingPaintMark.clickAt, now);
  emitLoafLine(sessionId, pendingPaintMark.clickAt, now);
  const delta = (now - pendingPaintMark.revealAt).toFixed(1);
  safeWarn(
    `[SWITCH-PERF-PAINT] sessionId=${sessionId.slice(0, 8)} reveal→paint=${delta}ms`,
  );
  pendingPaintMark = null;
}
