/**
 * Section-level timing recorder for git-safe-sync.
 *
 * Writes a per-invocation JSON log to the Mindstone Google Drive subfolder
 * `<Shared drives/Product>/git-safe-sync-logs/` so wall-time data accumulates
 * across runs and machines. Non-critical instrumentation — if the drive isn't
 * resolvable (non-Mindstone dev, Drive offline), logging is skipped with an
 * observable stderr/terminal note and the sync proceeds normally.
 *
 * Design notes:
 * - Section-level granularity matches the existing `logSection(...)` calls in
 *   git-safe-sync.ts. That's enough to answer "which step took the time" for
 *   99% of runs. Deeper per-exec timing would be noise.
 * - The pre-push hook (which runs `npm run validate:fast`) executes INSIDE
 *   `git push`, so its cost shows up bundled into the `push` span. The span
 *   note field documents this so future agents aren't surprised by a 30s push.
 * - Log format is one JSON object per run (not JSONL). Easy to `cat` or `jq`;
 *   trivially aggregated with `jq -s` over a directory of files.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { hostname } from 'os';
import { resolve, basename } from 'path';
import { resolveMindstoneProductDrive } from './mindstone-drive';

/** One timed section in the sync pipeline. */
export interface TimingSpan {
  name: string;
  startMs: number;
  endMs?: number;
  durationMs?: number;
  status: 'running' | 'ok' | 'err' | 'skipped';
  note?: string;
}

/** Final structured record written to disk. */
export interface SyncTimingRecord {
  schemaVersion: 1;
  timestamp: string;
  host: string;
  repo: string;
  branch: string;
  args: string[];
  outcome: 'success' | 'failure' | 'aborted';
  exitCode: number;
  totalMs: number;
  spans: TimingSpan[];
  notes: string[];
}

/**
 * Resolves the log directory. Precedence:
 *   1. `GIT_SAFE_SYNC_LOG_DIR` env var (explicit override — any path)
 *   2. Auto-detected Mindstone Google Shared Drive:
 *      `<drive>/git-safe-sync-logs` (matches the pattern used by transcript
 *      exports and pathologist reports; see
 *      `docs/project/GOOGLE_DRIVE_PATH_RESOLUTION.md`)
 *   3. `null` — logging is skipped. Sync instrumentation is a nice-to-have,
 *      not critical; non-Mindstone devs simply don't get persistent logs.
 *      The caller surfaces a one-line skip note so this isn't silent.
 *
 * `writeLog()` creates the directory lazily on first use, so the
 * `--diagnostics-only` / `--dry-run` flows don't leave empty folders behind
 * if they didn't actually write anything.
 */
export function resolveLogDir(): string | null {
  const override = process.env.GIT_SAFE_SYNC_LOG_DIR;
  if (override && override.length > 0) return override;

  const drive = resolveMindstoneProductDrive();
  if (drive) return resolve(drive, 'git-safe-sync-logs');

  return null;
}

export class SyncTimingRecorder {
  private readonly startMs: number;
  private readonly spans: TimingSpan[] = [];
  private readonly openSpans = new Map<string, TimingSpan>();
  private readonly notes: string[] = [];

  constructor(
    private readonly repo: string,
    private readonly branch: string,
    private readonly args: readonly string[],
  ) {
    this.startMs = performance.now();
  }

  /** Begin a named section. If an open span with the same name already exists, it is closed first. */
  start(name: string, note?: string): void {
    const existing = this.openSpans.get(name);
    if (existing) {
      this.end(name, 'ok', 'auto-closed (start called twice)');
    }
    const span: TimingSpan = {
      name,
      startMs: performance.now(),
      status: 'running',
      ...(note ? { note } : {}),
    };
    this.spans.push(span);
    this.openSpans.set(name, span);
  }

  /** End a named section with an outcome. Idempotent; second call is a no-op. */
  end(name: string, status: Exclude<TimingSpan['status'], 'running'> = 'ok', note?: string): void {
    const span = this.openSpans.get(name);
    if (!span) return;
    span.endMs = performance.now();
    span.durationMs = Math.round(span.endMs - span.startMs);
    span.status = status;
    if (note) {
      span.note = span.note ? `${span.note}; ${note}` : note;
    }
    this.openSpans.delete(name);
  }

  /**
   * Append a fully-formed span with explicit timestamps. Use this when the
   * span boundaries come from outside the recorder's own wall time — e.g.
   * parsing hook-emitted timing markers back from a child process's stderr
   * after it has already finished. Both timestamps MUST be in the
   * `performance.now()` timebase (same as `start()`/`end()`); callers with
   * epoch timestamps must convert via an anchor captured before they ran
   * the measured work. See the pre-push hook parser in git-safe-sync.ts for
   * the canonical example.
   *
   * No-op if `endMs < startMs`; the caller is the source of truth for those
   * values and nonsense inputs should be investigated, not silently fixed.
   */
  recordSpan(spec: {
    name: string;
    startMs: number;
    endMs: number;
    status: Exclude<TimingSpan['status'], 'running'>;
    note?: string;
  }): void {
    if (spec.endMs < spec.startMs) return;
    this.spans.push({
      name: spec.name,
      startMs: spec.startMs,
      endMs: spec.endMs,
      durationMs: Math.round(spec.endMs - spec.startMs),
      status: spec.status,
      ...(spec.note ? { note: spec.note } : {}),
    });
  }

  /**
   * Returns the current `performance.now()` value. Used by callers who need
   * to establish a perf/wall-clock anchor pair before launching a subprocess
   * that will emit its own wall-clock timestamps (which the caller will later
   * convert to perf ms via `recordSpan(...)`).
   */
  nowMs(): number {
    return performance.now();
  }

  /** Attach a free-form note to the run (appears in the log at run-level). */
  note(message: string): void {
    this.notes.push(message);
  }

  /** Close all outstanding spans (run terminated unexpectedly). */
  private closeAllOpenSpans(reason: string): void {
    for (const name of [...this.openSpans.keys()]) {
      this.end(name, 'err', reason);
    }
  }

  /** Produces a human-readable summary suitable for terminal output. */
  formatSummary(outcome: SyncTimingRecord['outcome'], exitCode: number): string {
    const totalMs = Math.round(performance.now() - this.startMs);
    const lines: string[] = [];
    lines.push(`── git-safe-sync timing ──`);
    lines.push(`  outcome: ${outcome} (exit ${exitCode})`);
    lines.push(`  total:   ${(totalMs / 1000).toFixed(2)}s`);
    if (this.spans.length > 0) {
      const widest = Math.max(...this.spans.map((s) => s.name.length));
      for (const span of this.spans) {
        const dur = span.durationMs != null ? `${(span.durationMs / 1000).toFixed(2)}s` : '—';
        const status =
          span.status === 'ok'
            ? ''
            : span.status === 'skipped'
              ? ' (skipped)'
              : span.status === 'err'
                ? ' (error)'
                : ' (incomplete)';
        const note = span.note ? `  [${span.note}]` : '';
        lines.push(`  ${span.name.padEnd(widest)}  ${dur.padStart(7)}${status}${note}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * Writes the structured log to disk. Returns the path on success, null if
   * the log directory couldn't be resolved (non-Mindstone dev with no env
   * override — expected, the caller prints a skip note) or the write failed
   * (unexpected, we print an error to stderr). Never throws.
   */
  writeLog(outcome: SyncTimingRecord['outcome'], exitCode: number): string | null {
    this.closeAllOpenSpans('run ended with open span');

    const logDir = resolveLogDir();
    if (!logDir) return null;
    const totalMs = Math.round(performance.now() - this.startMs);
    const now = new Date();
    const record: SyncTimingRecord = {
      schemaVersion: 1,
      timestamp: now.toISOString(),
      host: hostname(),
      repo: this.repo,
      branch: this.branch,
      args: [...this.args],
      outcome,
      exitCode,
      totalMs,
      spans: this.spans,
      notes: this.notes,
    };

    try {
      const yyyymm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const perRepoDir = resolve(logDir, this.repo, yyyymm);
      mkdirSync(perRepoDir, { recursive: true });

      const pad = (n: number): string => String(n).padStart(2, '0');
      const stamp =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
        `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const safeBranch = this.branch.replace(/[^A-Za-z0-9._-]/g, '_');
      const safeHost = hostname().replace(/[^A-Za-z0-9._-]/g, '_');
      // Include milliseconds to disambiguate concurrent runs.
      const ms = String(now.getMilliseconds()).padStart(3, '0');
      const filename = `${stamp}.${ms}-${safeHost}-${safeBranch}-exit${exitCode}.json`;
      const filePath = resolve(perRepoDir, filename);

      writeFileSync(filePath, JSON.stringify(record, null, 2));
      return filePath;
    } catch (err) {
      process.stderr.write(
        `  [timing] Could not write log to ${logDir}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.stderr.write(
        '  [timing] Sync result is unaffected. Check Google Drive mount, or override with GIT_SAFE_SYNC_LOG_DIR.\n',
      );
      return null;
    }
  }

  /**
   * Appends a path to the run's git-trace sidecar file (if --trace-git used).
   * Kept here for symmetry, though the actual trace output is produced by
   * child git processes via the GIT_TRACE_PERFORMANCE env var pointing at
   * this same file.
   */
  static ensureTraceFile(logPath: string): void {
    try {
      const header = `# GIT_TRACE_PERFORMANCE sidecar for ${basename(logPath)}\n`;
      appendFileSync(logPath, header);
    } catch {
      // Non-fatal: trace is best-effort.
    }
  }
}
