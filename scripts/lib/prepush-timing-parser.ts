/**
 * Parses per-phase timing markers emitted by `.husky/pre-push` out of the
 * captured stderr of a `git push` subprocess, and produces the child spans
 * that `scripts/git-safe-sync.ts` attaches to its JSON timing log.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Wire protocol (single line, tab-separated, anchored to start-of-line):
 *
 *     PREPUSH_TIMING\tv=1\tphase=<name>\tevent=<start|end>\tsec=<epoch>
 *
 * The hook emits two lines per phase (start + end). Unpaired starts (the
 * hook exited before the end marker because a phase failed) are recorded
 * as `status='err'` spans clamped to the push subprocess's own end time.
 *
 * Allowlisting `phase` and `event` defends against accidental matches in
 * arbitrary child-process output that happens to contain the prefix.
 *
 * Kept in its own module so it's testable without pulling in clipanion or
 * the rest of the git-safe-sync runtime.
 * ────────────────────────────────────────────────────────────────────────
 */

export const PREPUSH_TIMING_PREFIX = 'PREPUSH_TIMING\t';

export const PREPUSH_TIMING_PHASES = [
  'merge-integrity',
  'submodule-availability',
  'gate-nonce',
  'validate-fast',
  'certified-promote-check',
  'knip-health-fast',
  'vitest-related',
  'tier3-full-suite',
  'tier3-perf-suite',
  'realboot-suite',
] as const;
export type PrepushTimingPhase = (typeof PREPUSH_TIMING_PHASES)[number];

export const PREPUSH_TIMING_EVENTS = ['start', 'end'] as const;
export type PrepushTimingEvent = (typeof PREPUSH_TIMING_EVENTS)[number];

export interface PrepushChildSpan {
  name: string;
  startMs: number;
  endMs: number;
  status: 'ok' | 'err';
  note?: string;
}

export interface PrepushTimingParseResult {
  childSpans: PrepushChildSpan[];
  /** Stderr with marker lines removed — safe to replay to the user's terminal. */
  cleanedStderr: string;
  /** Diagnostic notes (unpaired markers, malformed lines). Caller decides what to do with them. */
  notes: string[];
}

/**
 * Parses pre-push timing markers out of a captured stderr buffer.
 *
 * `perfAnchorMs` + `wallAnchorSec` must be captured immediately before
 * spawning `git push`; they are used to convert hook epoch-second
 * timestamps into the recorder's `performance.now()` timebase.
 *
 * `pushEndPerfMs` is used to close any unpaired starts (hook exited
 * mid-phase) so the JSON log still accounts for the wall time that was
 * spent inside that failing phase.
 */
export function parsePrepushTimingMarkers(
  stderr: string,
  perfAnchorMs: number,
  wallAnchorSec: number,
  pushEndPerfMs: number,
): PrepushTimingParseResult {
  const lines = stderr.split('\n');
  const kept: string[] = [];
  const notes: string[] = [];
  const openStarts = new Map<PrepushTimingPhase, number>(); // phase -> start perfMs
  const childSpans: PrepushChildSpan[] = [];

  const phaseSet = new Set<string>(PREPUSH_TIMING_PHASES);
  const eventSet = new Set<string>(PREPUSH_TIMING_EVENTS);

  for (const line of lines) {
    if (!line.startsWith(PREPUSH_TIMING_PREFIX)) {
      kept.push(line);
      continue;
    }
    // Don't replay marker lines — they're protocol noise.

    const fields = line.split('\t');
    // Expected: ['PREPUSH_TIMING', 'v=1', 'phase=<name>', 'event=<name>', 'sec=<N>']
    const parsed: Record<string, string> = {};
    for (let i = 1; i < fields.length; i++) {
      const field = fields[i];
      if (!field) continue;
      const eq = field.indexOf('=');
      if (eq < 0) continue;
      parsed[field.slice(0, eq)] = field.slice(eq + 1);
    }

    if (parsed.v !== '1') {
      notes.push(`pre-push marker: unknown version '${parsed.v ?? '(missing)'}' — ignored`);
      continue;
    }
    const phase = parsed.phase;
    const event = parsed.event;
    const secStr = parsed.sec;
    if (!phase || !event || !secStr) {
      notes.push(`pre-push marker: malformed line '${line.slice(0, 120)}' — ignored`);
      continue;
    }
    if (!phaseSet.has(phase)) {
      notes.push(`pre-push marker: unknown phase '${phase}' — ignored`);
      continue;
    }
    if (!eventSet.has(event)) {
      notes.push(`pre-push marker: unknown event '${event}' — ignored`);
      continue;
    }
    const sec = Number.parseInt(secStr, 10);
    if (!Number.isFinite(sec)) {
      notes.push(`pre-push marker: non-numeric sec='${secStr}' — ignored`);
      continue;
    }

    const perfMs = perfAnchorMs + (sec - wallAnchorSec) * 1000;
    const phaseKey = phase as PrepushTimingPhase;

    if (event === 'start') {
      if (openStarts.has(phaseKey)) {
        notes.push(`pre-push marker: duplicate start for '${phase}' — keeping first`);
        continue;
      }
      openStarts.set(phaseKey, perfMs);
    } else {
      // event === 'end'
      const startMs = openStarts.get(phaseKey);
      if (startMs == null) {
        notes.push(`pre-push marker: end without start for '${phase}' — ignored`);
        continue;
      }
      openStarts.delete(phaseKey);
      childSpans.push({
        name: `push:${phase}`,
        startMs,
        endMs: perfMs,
        status: 'ok',
      });
    }
  }

  // When validate:fast fails, run-validate-fast.ts prints a precise failure
  // banner (naming the step + rerun command). If the validate-fast phase is
  // unpaired below, we surface that step instead of a bare "incomplete" note —
  // the generic note buried the real cause far up in long push output and cost
  // several confused re-run cycles. See docs/plans/260614_safe-sync-failstep-surfacing.
  const validateFastFailure = extractValidateFastFailure(kept);

  // Any remaining open starts mean the hook exited before emitting `end` —
  // the phase failed or was aborted. Record them with push-end as the close
  // point so the breakdown still accounts for that wall time.
  for (const [phase, startMs] of openStarts) {
    const note =
      phase === 'validate-fast' && validateFastFailure
        ? `failed at step: ${validateFastFailure.step}${validateFastFailure.rerun ? ` — rerun: ${validateFastFailure.rerun}` : ''}`
        : 'incomplete — hook exited before end marker';
    childSpans.push({
      name: `push:${phase}`,
      startMs,
      endMs: pushEndPerfMs,
      status: 'err',
      note,
    });
  }

  return {
    childSpans,
    cleanedStderr: kept.join('\n'),
    notes,
  };
}

export interface ValidateFastFailure {
  /** The failing step's name (run-validate-fast `step:` line). */
  step: string;
  /** The rerun hint (run-validate-fast `rerun:` line), if present. */
  rerun?: string;
}

/**
 * Extracts the failing-step name (+ rerun hint) from a `run-validate-fast.ts`
 * failure banner embedded in captured hook output. The banner shape is:
 *
 *     ═══…
 *       validate:fast FAILED
 *       step:    <name>
 *       <exit N | signal X>
 *       elapsed: …
 *       rerun:   <cmd>
 *       ran:     <cmd>        (optional)
 *     ═══…
 *
 * Returns null when no banner is present (a genuine incomplete — e.g. the hook
 * was killed/timed out before validate:fast emitted anything). Degrades
 * gracefully if the banner is partial: a `step:` with no `rerun:` still yields
 * the step name. Scans from the LAST `validate:fast FAILED` marker so the most
 * recent failure wins if output somehow contains more than one.
 */
export function extractValidateFastFailure(lines: readonly string[]): ValidateFastFailure | null {
  let markerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('validate:fast FAILED')) {
      markerIdx = i;
      break;
    }
  }
  if (markerIdx < 0) return null;

  let step: string | undefined;
  let rerun: string | undefined;
  // The banner is a short fixed block; scan a bounded window after the marker
  // and stop at the closing rule so we don't wander into unrelated output.
  for (let i = markerIdx + 1; i < lines.length && i < markerIdx + 12; i++) {
    const line = lines[i];
    if (/^[\s═]*═{3,}/.test(line)) break; // closing BANNER_RULE
    const stepMatch = /^\s*step:\s*(.+?)\s*$/.exec(line);
    if (stepMatch && step === undefined) step = stepMatch[1];
    const rerunMatch = /^\s*rerun:\s*(.+?)\s*$/.exec(line);
    if (rerunMatch && rerun === undefined) rerun = rerunMatch[1];
  }
  if (step === undefined) return null;
  return rerun === undefined ? { step } : { step, rerun };
}
