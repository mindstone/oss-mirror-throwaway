/**
 * Performance accumulator for tracking slow operations.
 * 
 * Tracks threshold-exceeded operations (store writes, process spawns) with:
 * - Counts since app start
 * - Max duration observed
 * - Immediate warn logging when thresholds exceeded
 * 
 * Used by diagnostic bundle export to include perfStats for remote diagnosis.
 */

import { createScopedLogger } from '@core/logger';

const logger = createScopedLogger({ service: 'perf' });

// Thresholds (ms) - conservative starting points
const STORE_WRITE_THRESHOLD_MS = 100; // 6 frames at 60fps
const SPAWN_THRESHOLD_MS = 2000; // Windows Defender can add 2-10s

// In-memory accumulator (resets on app restart)
const accumulator = {
  storeWrites: {
    slowCount: 0,
    maxMs: 0,
  },
  spawns: {
    slowCount: 0,
    maxMs: 0,
  },
  startTime: Date.now(),
};

/**
 * Record a store write operation duration.
 * Logs a warning if threshold exceeded.
 */
export function recordStoreWrite(durationMs: number, operation?: string): void {
  if (durationMs > accumulator.storeWrites.maxMs) {
    accumulator.storeWrites.maxMs = durationMs;
  }
  
  if (durationMs > STORE_WRITE_THRESHOLD_MS) {
    accumulator.storeWrites.slowCount++;
    logger.warn(
      { durationMs, operation, threshold: STORE_WRITE_THRESHOLD_MS },
      'Slow store write detected'
    );
  }
}

/**
 * Record a process spawn duration (time to first output or healthy).
 * Logs a warning if threshold exceeded.
 */
export function recordSpawn(durationMs: number, processName?: string): void {
  if (durationMs > accumulator.spawns.maxMs) {
    accumulator.spawns.maxMs = durationMs;
  }
  
  if (durationMs > SPAWN_THRESHOLD_MS) {
    accumulator.spawns.slowCount++;
    logger.warn(
      { durationMs, processName, threshold: SPAWN_THRESHOLD_MS },
      'Slow process spawn detected'
    );
  }
}

/**
 * Get current performance stats for diagnostic bundle export.
 */
export function getPerfStats(): {
  slowStoreWritesSinceStart: number;
  maxStoreWriteMs: number;
  slowSpawnsSinceStart: number;
  maxSpawnMs: number;
  uptimeMinutes: number;
  platform: string;
} {
  return {
    slowStoreWritesSinceStart: accumulator.storeWrites.slowCount,
    maxStoreWriteMs: Math.round(accumulator.storeWrites.maxMs),
    slowSpawnsSinceStart: accumulator.spawns.slowCount,
    maxSpawnMs: Math.round(accumulator.spawns.maxMs),
    uptimeMinutes: Math.round((Date.now() - accumulator.startTime) / 60000),
    platform: process.platform,
  };
}

/**
 * Get stats for periodic memory diagnostic logging.
 * Returns null if no slow operations recorded (to avoid log noise).
 */
export function getPerfStatsIfNotable(): ReturnType<typeof getPerfStats> | null {
  if (accumulator.storeWrites.slowCount === 0 && accumulator.spawns.slowCount === 0) {
    return null;
  }
  return getPerfStats();
}
