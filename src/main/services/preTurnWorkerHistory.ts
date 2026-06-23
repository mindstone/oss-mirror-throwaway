import path from 'node:path';
import * as fs from 'node:fs/promises';

export const PRE_TURN_WORKER_HISTORY_FILENAME = 'preturn-worker-history.json';
export const PRE_TURN_WORKER_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type PreTurnWorkerCrashCategory = 'oom' | 'unhandled_exception' | 'sigterm' | 'unknown';

export interface PreTurnWorkerHistoryV1 {
  v: 1;
  // Persisted across restarts. Counts crashes in a 7-day rolling window.
  recentCrashes: ReadonlyArray<{
    at: number;
    category: PreTurnWorkerCrashCategory;
  }>;
  lastCrashAt?: number;
  lastCrashCategory?: PreTurnWorkerCrashCategory;
  totalCrashesAllTime: number;
}

export interface PreTurnWorkerCrashRecord {
  at: number;
  category: PreTurnWorkerCrashCategory;
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === 'number' && value >= 0;
}

function isCrashCategory(value: unknown): value is PreTurnWorkerCrashCategory {
  return value === 'oom'
    || value === 'unhandled_exception'
    || value === 'sigterm'
    || value === 'unknown';
}

function assertHistoryV1(value: unknown): asserts value is PreTurnWorkerHistoryV1 {
  if (!value || typeof value !== 'object') {
    throw new Error('Pre-turn worker history must be an object');
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.v !== 1) {
    throw new Error('Unsupported pre-turn worker history version');
  }
  if (!Array.isArray(candidate.recentCrashes)) {
    throw new Error('Pre-turn worker history recentCrashes must be an array');
  }
  for (const crash of candidate.recentCrashes) {
    if (!crash || typeof crash !== 'object') {
      throw new Error('Pre-turn worker history crash entry must be an object');
    }
    const crashCandidate = crash as Record<string, unknown>;
    if (!isNonnegativeInteger(crashCandidate.at) || !isCrashCategory(crashCandidate.category)) {
      throw new Error('Pre-turn worker history crash entry is invalid');
    }
  }
  if (candidate.lastCrashAt !== undefined && !isNonnegativeInteger(candidate.lastCrashAt)) {
    throw new Error('Pre-turn worker history lastCrashAt is invalid');
  }
  if (candidate.lastCrashCategory !== undefined && !isCrashCategory(candidate.lastCrashCategory)) {
    throw new Error('Pre-turn worker history lastCrashCategory is invalid');
  }
  if (!isNonnegativeInteger(candidate.totalCrashesAllTime)) {
    throw new Error('Pre-turn worker history totalCrashesAllTime is invalid');
  }
}

export function createEmptyPreTurnWorkerHistory(): PreTurnWorkerHistoryV1 {
  return {
    v: 1,
    recentCrashes: [],
    totalCrashesAllTime: 0,
  };
}

export function getPreTurnWorkerHistoryPath(dataPath: string): string {
  return path.join(dataPath, PRE_TURN_WORKER_HISTORY_FILENAME);
}

export function parsePreTurnWorkerHistory(raw: string): PreTurnWorkerHistoryV1 {
  const parsed: unknown = JSON.parse(raw);
  assertHistoryV1(parsed);
  return {
    v: 1,
    recentCrashes: parsed.recentCrashes.map((crash) => ({
      at: crash.at,
      category: crash.category,
    })),
    ...(parsed.lastCrashAt !== undefined ? { lastCrashAt: parsed.lastCrashAt } : {}),
    ...(parsed.lastCrashCategory !== undefined ? { lastCrashCategory: parsed.lastCrashCategory } : {}),
    totalCrashesAllTime: parsed.totalCrashesAllTime,
  };
}

export async function readPreTurnWorkerHistory(dataPath: string): Promise<PreTurnWorkerHistoryV1> {
  try {
    const raw = await fs.readFile(getPreTurnWorkerHistoryPath(dataPath), 'utf8');
    return parsePreTurnWorkerHistory(raw);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return createEmptyPreTurnWorkerHistory();
    }
    throw err;
  }
}

export function appendPreTurnWorkerCrash(
  history: PreTurnWorkerHistoryV1,
  crash: PreTurnWorkerCrashRecord,
  now = crash.at,
): PreTurnWorkerHistoryV1 {
  const cutoff = now - PRE_TURN_WORKER_HISTORY_WINDOW_MS;
  const recentCrashes = [...history.recentCrashes, crash].filter((entry) => entry.at >= cutoff);

  return {
    v: 1,
    recentCrashes,
    lastCrashAt: crash.at,
    lastCrashCategory: crash.category,
    totalCrashesAllTime: history.totalCrashesAllTime + 1,
  };
}

export function countCrashesInLast7Days(history: PreTurnWorkerHistoryV1, now = Date.now()): number {
  const cutoff = now - PRE_TURN_WORKER_HISTORY_WINDOW_MS;
  return history.recentCrashes.filter((entry) => entry.at >= cutoff).length;
}

export async function writePreTurnWorkerHistory(
  dataPath: string,
  history: PreTurnWorkerHistoryV1,
): Promise<void> {
  const historyPath = getPreTurnWorkerHistoryPath(dataPath);
  const tempPath = `${historyPath}.tmp`;
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.writeFile(tempPath, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, historyPath);
}
