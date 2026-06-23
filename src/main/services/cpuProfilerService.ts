/**
 * Main Process CPU Profiler (dev:perf only)
 *
 * Uses Node.js `inspector` module to capture V8 CPU profiles of the main
 * process. Runs automatically when REBEL_PERF_MODE=1, capturing profiles
 * during idle periods (0 active agent turns) for background CPU diagnosis.
 *
 * Output:
 * - .cpuprofile files in userData/cpu-profiles/ (loadable in Chrome DevTools)
 * - .summary.json files with top functions by self-time (machine-readable)
 * - Structured log entries with top CPU consumers
 *
 * Gating: process.env.REBEL_PERF_MODE === '1' (set by npm run dev:perf)
 * Zero production cost — never loaded outside dev:perf.
 *
 * Usage:
 *   npm run dev:perf   # captures profiles automatically
 *
 * View raw profiles:
 *   1. Open Chrome → DevTools → Performance tab
 *   2. Click "Load profile..." and select a .cpuprofile file
 *
 * View AI-readable summaries:
 *   cat ~/Library/Application\ Support/mindstone-rebel/cpu-profiles/*.summary.json
 */

import * as inspector from 'node:inspector';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { getDataPath } from '@core/utils/dataPaths';
import { parseProfile, type CpuProfile } from './profileParser';
import { fireAndForget } from '@shared/utils/fireAndForget';

const log = createScopedLogger({ service: 'cpuProfiler' });

const DEFAULT_PROFILE_DURATION_MS = 5_000; // 5 seconds per capture (override via env)
const PROFILE_DURATION_ENV_KEY = 'REBEL_CPU_PROFILE_DURATION_MS';
const PROFILE_DURATION_MS = resolveProfileDurationMs();
const PROFILE_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
const IDLE_GRACE_MS = 60_000; // require 60s of idle before profiling
const SAMPLING_INTERVAL_US = 1000; // 1ms (V8 default, good balance of detail vs overhead)
const MAX_PROFILE_FILES = 20; // rotate old profiles to avoid filling disk

let session: inspector.Session | null = null;
let intervalTimer: ReturnType<typeof setTimeout> | null = null;
let isProfiling = false;
let lastTurnEndTime = 0; // tracks when turns last went idle

function resolveProfileDurationMs(): number {
  const raw = process.env[PROFILE_DURATION_ENV_KEY];
  if (!raw) {
    return DEFAULT_PROFILE_DURATION_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    log.warn(
      {
        envKey: PROFILE_DURATION_ENV_KEY,
        providedValue: raw,
        fallbackMs: DEFAULT_PROFILE_DURATION_MS,
      },
      'Invalid CPU profile duration override; using default',
    );
    return DEFAULT_PROFILE_DURATION_MS;
  }
  return parsed;
}

function getProfileDir(): string {
  return path.join(getDataPath(), 'cpu-profiles');
}

async function rotateOldProfiles(): Promise<void> {
  const dir = getProfileDir();
  try {
    const files = await fs.readdir(dir);
    const cpuFiles = files.filter(f => f.endsWith('.cpuprofile')).sort();
    if (cpuFiles.length > MAX_PROFILE_FILES) {
      const toDelete = cpuFiles.slice(0, cpuFiles.length - MAX_PROFILE_FILES);
      for (const file of toDelete) {
        await fs.unlink(path.join(dir, file));
        // Also delete companion summary
        const summaryFile = file.replace('.cpuprofile', '.summary.json');
        await fs.unlink(path.join(dir, summaryFile)).catch(() => {});
      }
      log.debug({ deleted: toDelete.length }, 'Rotated old CPU profiles');
    }
  } catch {
    // Dir may not exist yet
  }
}

async function captureProfile(): Promise<void> {
  if (isProfiling || !session) return;

  // Check for inspector conflict (e.g., --inspect flag or debugger attached)
  if (inspector.url() !== undefined) {
    log.debug('Inspector already open (debugger attached?), skipping CPU profile capture');
    return;
  }

  isProfiling = true;
  const profileDir = getProfileDir();
  await fs.mkdir(profileDir, { recursive: true });

  try {
    session.connect();
    session.post('Profiler.enable');
    session.post('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US });
    session.post('Profiler.start');

    log.debug({ durationMs: PROFILE_DURATION_MS }, 'CPU profile capture started');

    await new Promise(resolve => setTimeout(resolve, PROFILE_DURATION_MS));

    const currentSession = session;
    if (!currentSession) throw new Error('Session closed during capture');
    const profile = await new Promise<CpuProfile>((resolve, reject) => {
      currentSession.post('Profiler.stop', (err, { profile } : { profile: CpuProfile }) => {
        if (err) reject(err);
        else resolve(profile);
      });
    });

    session.post('Profiler.disable');
    session.disconnect();

    // Write raw .cpuprofile
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const profilePath = path.join(profileDir, `cpu-${timestamp}.cpuprofile`);
    await fs.writeFile(profilePath, JSON.stringify(profile));

    // Parse and write summary
    const summary = parseProfile(profile);
    summary.profileFile = path.basename(profilePath);
    const summaryPath = profilePath.replace('.cpuprofile', '.summary.json');
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));

    // Log key findings
    const topN = summary.topFunctions.slice(0, 5);
    log.info(
      {
        profilerChannel: 'main-cpu',
        durationMs: summary.durationMs,
        totalSamples: summary.totalSamples,
        idlePercent: summary.idlePercent,
        gcPercent: summary.gcPercent,
        appCpuPercent: summary.appCpuPercent,
        topFunctions: topN.map(f => ({
          name: f.functionName,
          url: f.url ? `${path.basename(f.url)}:${f.lineNumber}` : '',
          selfPercent: f.selfTimePercent,
        })),
        profileFile: summary.profileFile,
      },
      `CPU profile captured (${summary.appCpuPercent}% active, ${summary.idlePercent}% idle, ${summary.gcPercent}% GC)`
    );

    await rotateOldProfiles();
  } catch (err) {
    log.error({ err }, 'CPU profile capture failed');
    try { session?.disconnect(); } catch { /* ignore */ }
  } finally {
    isProfiling = false;
  }
}

/**
 * Initialize the automatic CPU profiler.
 * Only call this when REBEL_PERF_MODE=1 and !app.isPackaged.
 *
 * @param getActiveTurnCount Function that returns current active turn count
 */
export function initCpuProfiler(getActiveTurnCount: () => number): void {
  if (session) {
    log.warn('CPU profiler already initialized');
    return;
  }

  session = new inspector.Session();
  lastTurnEndTime = Date.now();

  log.info(
    {
      intervalMs: PROFILE_INTERVAL_MS,
      durationMs: PROFILE_DURATION_MS,
      idleGraceMs: IDLE_GRACE_MS,
      samplingIntervalUs: SAMPLING_INTERVAL_US,
      maxFiles: MAX_PROFILE_FILES,
      profileDir: getProfileDir(),
    },
    'CPU profiler initialized (dev:perf mode)'
  );

  // Schedule periodic captures
  const tick = () => {
    const activeTurns = getActiveTurnCount();
    const idleDuration = Date.now() - lastTurnEndTime;

    if (activeTurns > 0) {
      log.debug({ activeTurns }, 'Skipping CPU profile (turns active)');
    } else if (idleDuration < IDLE_GRACE_MS) {
      log.debug({ idleDurationMs: idleDuration }, 'Skipping CPU profile (not idle long enough)');
    } else {
      fireAndForget(captureProfile(), 'cpuProfilerService.line215');
    }

    intervalTimer = setTimeout(tick, PROFILE_INTERVAL_MS);
  };

  // First capture after one interval (give app time to settle after startup)
  intervalTimer = setTimeout(tick, PROFILE_INTERVAL_MS);
}

/**
 * Stop the CPU profiler and clean up.
 */
export function stopCpuProfiler(): void {
  if (intervalTimer) {
    clearTimeout(intervalTimer);
    intervalTimer = null;
  }
  if (session) {
    try { session.disconnect(); } catch { /* ignore */ }
    session = null;
  }
  log.info('CPU profiler stopped');
}

/**
 * Manually trigger a single CPU profile capture (for ad-hoc debugging).
 * Returns the path to the profile file, or null on failure.
 */
export async function captureOnDemand(): Promise<string | null> {
  if (!session) {
    session = new inspector.Session();
  }
  const before = isProfiling;
  try {
    isProfiling = false; // reset guard
    await captureProfile();
    const dir = getProfileDir();
    const files = await fs.readdir(dir);
    const latest = files.filter(f => f.endsWith('.cpuprofile')).sort().pop();
    return latest ? path.join(dir, latest) : null;
  } finally {
    isProfiling = before;
  }
}
