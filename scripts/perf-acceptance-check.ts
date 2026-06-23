#!/usr/bin/env tsx
/**
 * Perf-diagnostic acceptance harness — Stage 5 of
 * `docs/plans/260423_secondary_process_cpu_observability.md`.
 *
 * Parses a `mindstone-rebel.log` tail (NDJSON-per-line Pino output) and
 * asserts AC1-AC5 as defined in the plan:
 *
 *   AC1 (Stage 1):  blurred/minimised sessions produce ≥8 Memory diagnostic
 *                   samples with no gap > 180s; `blurState` field present.
 *   AC2 (Stage 2):  every Memory diagnostic has `eventLoopDelay` with
 *                   p50/p95/p99/max/mean/windowDurationMs OR explicit
 *                   `{ status: 'unavailable' }`.
 *   AC3 (Stage 3):  renderer long-task attribution. Currently SKIPPED —
 *                   Stage 3 prod path is killswitched pending security
 *                   refinement (see `runtimeConfig.ts:getProdPerfMonitorEnabled`).
 *   AC4 (Stage 4a): when super-mcp is running, `superMcpLifecycle` has
 *                   pid / uptime / startCount / restartCount / circuitBreakerActive;
 *                   `processes[]` contains a matching `type: 'subprocess'` row.
 *   AC5 (Stage 4b): under live MCP workload, `superMcpChildStats.children`
 *                   non-empty OR `superMcpChildStats.status === 'unsupported'`.
 *
 * Exit code 0 on all pass / skipped; 1 on any AC fail or unexpected parse error.
 *
 * Usage:
 *   npx tsx scripts/perf-acceptance-check.ts --log /path/to/mindstone-rebel.log
 *   npx tsx scripts/perf-acceptance-check.ts           # auto-detect on macOS
 *   npx tsx scripts/perf-acceptance-check.ts --window-min 20 --min-samples 4
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';

/** Coarse shape of a `Memory diagnostic` payload — only fields we check. */
interface MemoryDiagnosticLine {
  msg: string;
  time?: number;
  level?: number;
  blurState?: unknown;
  eventLoopDelay?: unknown;
  processes?: unknown;
  superMcpLifecycle?: unknown;
  superMcpChildStats?: unknown;
}

type Verdict = 'pass' | 'fail' | 'skip';

interface AcCheck {
  id: string;
  label: string;
  verdict: Verdict;
  reason: string;
}

interface CliArgs {
  logPath: string;
  windowMinutes: number;
  minBackgroundSamples: number;
}

/* ------------------------------------------------------------------ */
/* CLI + I/O                                                           */
/* ------------------------------------------------------------------ */

function detectDefaultLogPath(): string | null {
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return path.join(
        home,
        'Library',
        'Application Support',
        'mindstone-rebel',
        'logs',
        'mindstone-rebel.log',
      );
    case 'linux':
      return path.join(home, '.config', 'mindstone-rebel', 'logs', 'mindstone-rebel.log');
    case 'win32': {
      const appData = process.env.APPDATA;
      if (!appData) return null;
      return path.join(appData, 'mindstone-rebel', 'logs', 'mindstone-rebel.log');
    }
    default:
      return null;
  }
}

function parseArgs(argv: string[]): CliArgs {
  let logPath: string | null = null;
  let windowMinutes = 20;
  let minBackgroundSamples = 8;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--log':
        logPath = next;
        i += 1;
        break;
      case '--window-min': {
        const parsed = Number(next);
        if (Number.isFinite(parsed) && parsed > 0) windowMinutes = parsed;
        i += 1;
        break;
      }
      case '--min-samples': {
        const parsed = Number(next);
        if (Number.isFinite(parsed) && parsed > 0) minBackgroundSamples = parsed;
        i += 1;
        break;
      }
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        // ignore unknowns — harness is intended to tolerate wrapper args
        break;
    }
  }

  if (logPath === null) {
    const detected = detectDefaultLogPath();
    if (detected === null) {
      throw new Error(
        'Could not detect default log path for this OS. Pass --log /path/to/mindstone-rebel.log',
      );
    }
    logPath = detected;
  }

  return { logPath, windowMinutes, minBackgroundSamples };
}

function printHelp(): void {
  console.log(`Usage: npx tsx scripts/perf-acceptance-check.ts [options]

Options:
  --log <path>        Path to mindstone-rebel.log (auto-detected on macOS/Linux/Windows).
  --window-min <n>    Trailing window in minutes to analyse (default: 20).
  --min-samples <n>   AC1 minimum samples during a blurred/minimised window (default: 8).
  --help, -h          Show this help.`);
}

/* ------------------------------------------------------------------ */
/* Parse                                                               */
/* ------------------------------------------------------------------ */

/** Parse NDJSON; silently drop any line that isn't valid JSON + contains `"msg"`. */
function parseMemoryDiagnosticLines(
  contents: string,
  windowMs: number,
): MemoryDiagnosticLine[] {
  const now = Date.now();
  const cutoff = now - windowMs;
  const out: MemoryDiagnosticLine[] = [];

  // Walk bottom-up so we can stop early once past the window.
  const lines = contents.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    if (!line.includes('"Memory diagnostic"')) continue;
    let parsed: MemoryDiagnosticLine;
    try {
      parsed = JSON.parse(line) as MemoryDiagnosticLine;
    } catch {
      continue;
    }
    if (parsed.msg !== 'Memory diagnostic') continue;
    if (typeof parsed.time === 'number' && parsed.time < cutoff) break;
    out.unshift(parsed);
  }
  return out;
}

/**
 * Log rotation (pino-roll @ 5m default) produces `mindstone-rebel.log`,
 * `mindstone-rebel.log.1`, `mindstone-rebel.log.2`, ... in the same
 * directory. Grabbing only the current file can undercount samples if
 * the session spanned a rotation. This helper finds every file matching
 * `mindstone-rebel.log*` in the log directory, sorted newest-first by
 * mtime, and reads enough of them that the bottom of the concatenated
 * tail covers the requested window.
 *
 * We stop reading once an older file's mtime is more than `windowMs`
 * behind now — anything older can only contain pre-window lines.
 *
 * Returns the concatenated contents (oldest-first) so that
 * `parseMemoryDiagnosticLines` still walks bottom-up correctly.
 */
function readLogFileTail(explicitPath: string, windowMs: number): string {
  if (!existsSync(explicitPath)) {
    throw new Error(`Log file not found: ${explicitPath}`);
  }

  const dir = path.dirname(explicitPath);
  const basename = path.basename(explicitPath);

  let candidateFiles: string[] = [];
  try {
    const entries = readdirSync(dir);
    candidateFiles = entries
      .filter((name) => name === basename || name.startsWith(`${basename}.`))
      .map((name) => path.join(dir, name));
  } catch {
    // Directory unreadable — fall back to just the explicit file.
    return readFileSync(explicitPath, 'utf-8');
  }

  if (candidateFiles.length === 0) {
    return readFileSync(explicitPath, 'utf-8');
  }

  // Sort newest-first by mtime; ties broken by name (rolled files have
  // ascending numeric suffixes, so the current active file always wins
  // on mtime in normal operation).
  const withStats = candidateFiles
    .map((p) => {
      try {
        return { path: p, mtimeMs: statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { path: string; mtimeMs: number } => x !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const cutoff = Date.now() - windowMs;
  // Accept files until the FIRST file whose mtime is already older than
  // the window cutoff (that file may still straddle the window, so we
  // include it; anything strictly older is safe to drop).
  const selected: string[] = [];
  for (const entry of withStats) {
    selected.push(entry.path);
    if (entry.mtimeMs < cutoff) break;
  }

  // Read and concatenate oldest-first so the resulting bottom-of-string
  // corresponds to the newest entries, which is what
  // `parseMemoryDiagnosticLines` walks upward from.
  selected.reverse();
  const chunks: string[] = [];
  for (const p of selected) {
    try {
      chunks.push(readFileSync(p, 'utf-8'));
    } catch {
      // Skip unreadable rotated files; the explicit one was verified above.
    }
  }
  return chunks.join('\n');
}

/* ------------------------------------------------------------------ */
/* AC checks                                                           */
/* ------------------------------------------------------------------ */

function checkAc1(
  samples: MemoryDiagnosticLine[],
  minBackgroundSamples: number,
): AcCheck {
  // Runtime emits 'minimized' (American). Accept 'minimised' as a defensive
  // alias in case a future rename happens — the plan wording uses both.
  const backgroundSamples = samples.filter(
    (s) =>
      s.blurState === 'blurred' ||
      s.blurState === 'minimized' ||
      s.blurState === 'minimised',
  );

  const hasBlurStateOnAll = samples.every(
    (s) => typeof s.blurState === 'string' && s.blurState.length > 0,
  );
  if (!hasBlurStateOnAll) {
    return {
      id: 'AC1',
      label: 'Stage 1 — blur/minimise cadence + blurState field',
      verdict: 'fail',
      reason: `At least one Memory diagnostic sample is missing blurState. (${samples.length} samples inspected.)`,
    };
  }

  if (backgroundSamples.length < minBackgroundSamples) {
    return {
      id: 'AC1',
      label: 'Stage 1 — blur/minimise cadence + blurState field',
      verdict: 'fail',
      reason: `Only ${backgroundSamples.length} blurred/minimised samples in the window (need ≥ ${minBackgroundSamples}). Did you run Session B (idle background, 20 min) against a packaged build?`,
    };
  }

  // No gap > 180s between any two adjacent background samples.
  const MAX_GAP_MS = 180_000;
  for (let i = 1; i < backgroundSamples.length; i += 1) {
    const prev = backgroundSamples[i - 1].time;
    const curr = backgroundSamples[i].time;
    if (typeof prev === 'number' && typeof curr === 'number' && curr - prev > MAX_GAP_MS) {
      return {
        id: 'AC1',
        label: 'Stage 1 — blur/minimise cadence + blurState field',
        verdict: 'fail',
        reason: `Gap of ${Math.round((curr - prev) / 1000)}s between background samples at ~${new Date(prev).toISOString()} and ~${new Date(curr).toISOString()}. The 120s blur/minimise cadence is not holding; Stage 1 regression.`,
      };
    }
  }

  return {
    id: 'AC1',
    label: 'Stage 1 — blur/minimise cadence + blurState field',
    verdict: 'pass',
    reason: `${backgroundSamples.length} blurred/minimised samples observed; no gap > 180s; blurState present on all ${samples.length} samples.`,
  };
}

function checkAc2(samples: MemoryDiagnosticLine[]): AcCheck {
  if (samples.length === 0) {
    return {
      id: 'AC2',
      label: 'Stage 2 — eventLoopDelay on every Memory diagnostic',
      verdict: 'fail',
      reason: 'No Memory diagnostic samples in the window to check.',
    };
  }

  const expectedKeys = ['p50', 'p95', 'p99', 'max', 'mean', 'windowDurationMs'] as const;

  for (const s of samples) {
    const eld = s.eventLoopDelay;
    if (eld === null || eld === undefined) {
      return {
        id: 'AC2',
        label: 'Stage 2 — eventLoopDelay on every Memory diagnostic',
        verdict: 'fail',
        reason: `Sample at ~${s.time ? new Date(s.time).toISOString() : 'unknown time'} is missing eventLoopDelay entirely. AC2 requires either the full histogram OR an explicit { status: 'unavailable' }.`,
      };
    }

    if (typeof eld === 'object' && (eld as { status?: unknown }).status === 'unavailable') {
      continue; // explicit unavailable — allowed per AC2
    }

    if (typeof eld !== 'object') {
      return {
        id: 'AC2',
        label: 'Stage 2 — eventLoopDelay on every Memory diagnostic',
        verdict: 'fail',
        reason: `Sample has non-object eventLoopDelay (${typeof eld}).`,
      };
    }

    const obj = eld as Record<string, unknown>;
    for (const key of expectedKeys) {
      if (typeof obj[key] !== 'number') {
        return {
          id: 'AC2',
          label: 'Stage 2 — eventLoopDelay on every Memory diagnostic',
          verdict: 'fail',
          reason: `Sample at ~${s.time ? new Date(s.time).toISOString() : 'unknown time'} is missing eventLoopDelay.${key} (or it's not a number). AC2 requires the full p50/p95/p99/max/mean/windowDurationMs set OR explicit { status: 'unavailable' }.`,
        };
      }
    }
  }

  return {
    id: 'AC2',
    label: 'Stage 2 — eventLoopDelay on every Memory diagnostic',
    verdict: 'pass',
    reason: `All ${samples.length} samples include eventLoopDelay with the expected shape (or explicit status='unavailable').`,
  };
}

function checkAc3(): AcCheck {
  return {
    id: 'AC3',
    label: 'Stage 3 — renderer long-task attribution',
    verdict: 'skip',
    reason: 'Stage 3 production path is killswitched pending security refinement. See getProdPerfMonitorEnabled() in src/main/runtimeConfig.ts.',
  };
}

function checkAc4(samples: MemoryDiagnosticLine[]): AcCheck {
  const runningSamples = samples.filter((s) => {
    const lc = s.superMcpLifecycle;
    return (
      typeof lc === 'object' &&
      lc !== null &&
      (lc as { isRunning?: unknown }).isRunning === true
    );
  });

  if (runningSamples.length === 0) {
    return {
      id: 'AC4',
      label: 'Stage 4a — super-mcp lifecycle + synth process row',
      verdict: 'skip',
      reason: 'No Memory diagnostic samples in the window show super-mcp as running. Run Session C (active conversation) or Session A with MCP enabled.',
    };
  }

  const expectedKeys = ['pid', 'startCount', 'restartCount', 'circuitBreakerActive'] as const;

  for (const s of runningSamples) {
    const lc = s.superMcpLifecycle as Record<string, unknown>;
    for (const key of expectedKeys) {
      if (lc[key] === undefined) {
        return {
          id: 'AC4',
          label: 'Stage 4a — super-mcp lifecycle + synth process row',
          verdict: 'fail',
          reason: `Sample at ~${s.time ? new Date(s.time).toISOString() : 'unknown time'} is missing superMcpLifecycle.${key}. Stage 4a contract violation.`,
        };
      }
    }

    // uptime may be numeric or computed — at least expect the field to exist.
    if (lc.uptime === undefined && lc.uptimeMs === undefined) {
      return {
        id: 'AC4',
        label: 'Stage 4a — super-mcp lifecycle + synth process row',
        verdict: 'fail',
        reason: `superMcpLifecycle missing uptime (or uptimeMs).`,
      };
    }

    // processes[] should contain the synth row — or an existing row with the
    // super-mcp PID (collision suppression debug-logged but still valid).
    const procs = Array.isArray(s.processes) ? (s.processes as Array<Record<string, unknown>>) : [];
    const pid = lc.pid as number | null;
    const hasSynth =
      pid !== null &&
      procs.some(
        (p) =>
          (p.type === 'subprocess' && p.pid === pid) ||
          (typeof p.label === 'string' && p.label.startsWith('super-mcp') && p.pid === pid),
      );
    if (!hasSynth) {
      return {
        id: 'AC4',
        label: 'Stage 4a — super-mcp lifecycle + synth process row',
        verdict: 'fail',
        reason: `super-mcp is running (pid=${String(pid)}) but no matching processes[] row found. Synth row emission regressed.`,
      };
    }
  }

  return {
    id: 'AC4',
    label: 'Stage 4a — super-mcp lifecycle + synth process row',
    verdict: 'pass',
    reason: `${runningSamples.length} samples had running super-mcp; all contain the required lifecycle fields + a matching processes[] row.`,
  };
}

function checkAc5(samples: MemoryDiagnosticLine[]): AcCheck {
  const populated = samples.filter((s) => {
    const stats = s.superMcpChildStats;
    return typeof stats === 'object' && stats !== null;
  });

  if (populated.length === 0) {
    return {
      id: 'AC5',
      label: 'Stage 4b — super-mcp /stats child visibility',
      verdict: 'fail',
      reason: 'No Memory diagnostic samples have superMcpChildStats populated. Stage 4b emission regressed (should always be present, even as status="unavailable").',
    };
  }

  // Accept any of: children non-empty, status='unsupported', status='unavailable'
  // (if super-mcp disabled or not yet up), status='stale' (shortly after restart).
  const anyChildren = populated.some((s) => {
    const stats = s.superMcpChildStats as { payload?: unknown; status?: unknown };
    if (stats.status === 'unsupported') return true;
    const payload = stats.payload;
    if (typeof payload !== 'object' || payload === null) return false;
    const children = (payload as { children?: unknown }).children;
    return Array.isArray(children) && children.length > 0;
  });

  if (anyChildren) {
    return {
      id: 'AC5',
      label: 'Stage 4b — super-mcp /stats child visibility',
      verdict: 'pass',
      reason: `${populated.length} samples inspected; at least one has non-empty children or status='unsupported'.`,
    };
  }

  // Downgrade to skip if super-mcp never came up (otherwise we'd fail a
  // session that deliberately disabled MCP).
  const sawRunning = populated.some((s) => {
    const lc = s.superMcpLifecycle;
    return typeof lc === 'object' && lc !== null && (lc as { isRunning?: unknown }).isRunning === true;
  });

  if (!sawRunning) {
    return {
      id: 'AC5',
      label: 'Stage 4b — super-mcp /stats child visibility',
      verdict: 'skip',
      reason: 'super-mcp never showed isRunning=true in the window. Run Session C (active conversation) to exercise the /stats path.',
    };
  }

  return {
    id: 'AC5',
    label: 'Stage 4b — super-mcp /stats child visibility',
    verdict: 'fail',
    reason: 'super-mcp was running but superMcpChildStats.children was never non-empty and status was never "unsupported". Either /stats is timing out / erroring every tick (check "super-mcp /stats: status degraded" warn logs) or no children were connected during the window.',
  };
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function formatCheck(check: AcCheck): string {
  const glyph = check.verdict === 'pass' ? '✓' : check.verdict === 'skip' ? '○' : '✗';
  return `${glyph} ${check.id} (${check.verdict.toUpperCase()}) — ${check.label}\n    ${check.reason}`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.logPath)) {
    console.error(`✗ Log file not found: ${args.logPath}`);
    console.error('Pass --log /path/to/mindstone-rebel.log or run the app so it creates one.');
    process.exit(1);
  }

  const windowMs = args.windowMinutes * 60 * 1000;

  let contents: string;
  try {
    // Reads the target file AND any rotated siblings (`<basename>.N`)
    // whose mtime could contain window-relevant lines.
    contents = readLogFileTail(args.logPath, windowMs);
  } catch (err) {
    console.error(`✗ Failed to read log file: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const samples = parseMemoryDiagnosticLines(contents, windowMs);

  console.log(
    `Perf-acceptance check — log=${args.logPath} window=${args.windowMinutes}min samples=${samples.length}`,
  );
  console.log();

  const checks: AcCheck[] = [
    checkAc1(samples, args.minBackgroundSamples),
    checkAc2(samples),
    checkAc3(),
    checkAc4(samples),
    checkAc5(samples),
  ];

  for (const check of checks) {
    console.log(formatCheck(check));
    console.log();
  }

  const passed = checks.filter((c) => c.verdict === 'pass').length;
  const skipped = checks.filter((c) => c.verdict === 'skip').length;
  const failed = checks.filter((c) => c.verdict === 'fail').length;

  console.log(`Summary: ${passed} pass, ${skipped} skip, ${failed} fail (of ${checks.length}).`);

  if (failed > 0) {
    process.exit(1);
  }
}

try {
  main();
} catch (err) {
  console.error(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
