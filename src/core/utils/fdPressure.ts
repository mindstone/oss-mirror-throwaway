import fs from 'node:fs';

export const FD_PRESSURE_BANDS = [50, 75, 90] as const;
export type FdPressureBand = (typeof FD_PRESSURE_BANDS)[number];
export type FdPressureAxis = 'count' | 'fd-number';

/** Count-axis floor guard (applies ONLY to openFdCount/soft-limit axis). */
export const FD_PRESSURE_COUNT_FLOOR = 512;

/** Darwin `OPEN_MAX` cliff observed in the fd-exhaustion incident. */
export const DARWIN_OPEN_MAX_FD = 10_240;

type FdDirectorySource = 'darwin-dev-fd' | 'linux-proc-self-fd';

export type FdPressureSample =
  | {
      status: 'ok';
      source: FdDirectorySource;
      openFdCount: number;
      maxFdNumber: number;
    }
  | {
      status: 'unsupported';
      reason: string;
    }
  | {
      status: 'unavailable';
      error: string;
    };

type ReadFdPressureDeps = {
  platform?: NodeJS.Platform;
  readdirSync?: (path: string) => string[];
};

let cachedOpenFileSoftLimit: number | null | undefined;

/**
 * Read open-FD pressure from the platform-native descriptor directory.
 *
 * - darwin: `/dev/fd`
 * - linux: `/proc/self/fd`
 * - win32: unsupported (Node does not expose raw process handle enumeration
 *   without native APIs such as `GetProcessHandleCount`).
 *
 * Never throws: any read/parsing failure maps to `status: 'unavailable'`.
 *
 * Mobile note: React Native does not run a Node process and has no `node:fs`
 * descriptor namespace; this helper is desktop/cloud-only.
 */
export function readFdPressure(deps: ReadFdPressureDeps = {}): FdPressureSample {
  const platform = deps.platform ?? process.platform;
  const readdirSync = deps.readdirSync ?? ((dirPath: string) => fs.readdirSync(dirPath));

  if (platform === 'win32') {
    return {
      status: 'unsupported',
      reason: 'win32 has no user-mode raw fd/handle enumeration in Node without native modules',
    };
  }

  if (platform !== 'darwin' && platform !== 'linux') {
    return {
      status: 'unsupported',
      reason: `platform ${platform} does not expose a supported fd directory`,
    };
  }

  const source: FdDirectorySource = platform === 'darwin'
    ? 'darwin-dev-fd'
    : 'linux-proc-self-fd';
  const path = platform === 'darwin' ? '/dev/fd' : '/proc/self/fd';

  try {
    const entries = readdirSync(path);
    const maxFdNumber = findMaxFdNumber(entries);
    return {
      status: 'ok',
      source,
      openFdCount: entries.length,
      maxFdNumber,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

type AssessFdPressureBandInput = {
  platform: NodeJS.Platform;
  openFdCount: number;
  maxFdNumber: number;
  softLimit: number | null;
};

export type FdPressureBandAssessment = {
  band: FdPressureBand;
  triggerAxes: readonly FdPressureAxis[];
  countAxisRatio: number | null;
  numberAxisRatio: number | null;
};

/**
 * Evaluate fd pressure against two axes:
 * - count axis: openFdCount / softLimit (guarded by FD_PRESSURE_COUNT_FLOOR)
 * - fd-number axis (darwin only): maxFdNumber / DARWIN_OPEN_MAX_FD
 *
 * Returns the highest reached band; null when no band is reached.
 */
export function assessFdPressureBand(input: AssessFdPressureBandInput): FdPressureBandAssessment | null {
  const countAxisRatio = (
    input.softLimit !== null
      && input.softLimit > 0
      && input.openFdCount >= FD_PRESSURE_COUNT_FLOOR
  )
    ? input.openFdCount / input.softLimit
    : null;

  const numberAxisRatio = input.platform === 'darwin'
    ? input.maxFdNumber / DARWIN_OPEN_MAX_FD
    : null;

  const countBand = ratioToBand(countAxisRatio);
  const numberBand = ratioToBand(numberAxisRatio);
  const band = pickHigherBand(countBand, numberBand);
  if (band === null) {
    return null;
  }

  const triggerAxes: FdPressureAxis[] = [];
  if (countBand === band) triggerAxes.push('count');
  if (numberBand === band) triggerAxes.push('fd-number');

  return {
    band,
    triggerAxes,
    countAxisRatio,
    numberAxisRatio,
  };
}

type SelectNextBandInput = {
  assessment: FdPressureBandAssessment | null;
  seenBands: ReadonlySet<FdPressureBand>;
};

/**
 * Stateless dedup gate: return the current assessment only if this escalation
 * band has not been emitted in the current process.
 */
export function selectNextFdPressureBand(input: SelectNextBandInput): FdPressureBandAssessment | null {
  if (input.assessment === null) {
    return null;
  }
  return input.seenBands.has(input.assessment.band) ? null : input.assessment;
}

/**
 * Lazy one-time read of the process soft `open_files` rlimit.
 *
 * `process.report.getReport()` can cost ~12ms on real machines, so callers
 * should use this cached accessor from non-interactive paths only.
 */
export function getCachedOpenFileSoftLimit(
  readProcessReport: () => unknown = defaultReadProcessReport,
): number | null {
  if (cachedOpenFileSoftLimit !== undefined) {
    return cachedOpenFileSoftLimit;
  }
  try {
    cachedOpenFileSoftLimit = extractOpenFileSoftLimit(readProcessReport());
  } catch {
    cachedOpenFileSoftLimit = null;
  }
  return cachedOpenFileSoftLimit;
}

export function _resetFdPressureStateForTesting(): void {
  cachedOpenFileSoftLimit = undefined;
}

function findMaxFdNumber(entries: string[]): number {
  let maxFdNumber = 0;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const value = Number(entry);
    if (Number.isInteger(value) && value >= 0 && value > maxFdNumber) {
      maxFdNumber = value;
    }
  }
  return maxFdNumber;
}

function ratioToBand(ratio: number | null): FdPressureBand | null {
  if (ratio === null || !Number.isFinite(ratio)) return null;
  if (ratio >= 0.9) return 90;
  if (ratio >= 0.75) return 75;
  if (ratio >= 0.5) return 50;
  return null;
}

function pickHigherBand(a: FdPressureBand | null, b: FdPressureBand | null): FdPressureBand | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

function defaultReadProcessReport(): unknown {
  const reportAccessor = (
    process as NodeJS.Process & { report?: { getReport?: () => unknown } }
  ).report?.getReport;
  if (typeof reportAccessor !== 'function') {
    return null;
  }
  return reportAccessor.call(process.report);
}

function extractOpenFileSoftLimit(report: unknown): number | null {
  if (!report || typeof report !== 'object') {
    return null;
  }
  const userLimits = (report as { userLimits?: unknown }).userLimits;
  if (!userLimits || typeof userLimits !== 'object') {
    return null;
  }
  const openFiles = (userLimits as { open_files?: unknown }).open_files;
  if (!openFiles || typeof openFiles !== 'object') {
    return null;
  }
  const soft = (openFiles as { soft?: unknown }).soft;
  return coercePositiveInteger(soft);
}

function coercePositiveInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}
