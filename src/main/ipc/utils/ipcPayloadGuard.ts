/**
 * IPC Payload Size Guard — Detects oversized IPC payloads during perf tests.
 *
 * Pure, unit-testable module. All logic is gated behind `REBEL_E2E_PERF_MODE=1`
 * so there is zero overhead in production or regular E2E tests.
 *
 * Thresholds:
 * - WARN: >64KB — logged for awareness
 * - FAIL: >256KB — hard failure in perf tests
 *
 * Known gap: ~30+ IPC handlers registered via direct `ipcMain.handle()` bypass
 * the ElectronHandlerRegistry and are NOT instrumented. See planning doc for details.
 *
 * @see docs/plans/260328_perf_regression_tests.md — Full planning doc
 * @see src/main/ipc/utils/ElectronHandlerRegistry.ts — Integration point
 */

/** Module-level cache — checked once at load, never per-call. */
const IS_PERF_MODE = process.env.REBEL_E2E_PERF_MODE === '1';

/** 64KB — payloads above this are logged as warnings. */
export const WARN_THRESHOLD = 64 * 1024;

/** 256KB — payloads above this are hard failures in perf tests. */
export const FAIL_THRESHOLD = 256 * 1024;

/** A single violation record. */
export interface PayloadViolation {
  channel: string;
  size: number;
  level: 'warn' | 'fail';
  timestamp: number;
}

/** In-memory accumulator (module singleton). */
const violations: PayloadViolation[] = [];

/**
 * Estimate the byte size of an IPC payload.
 *
 * Handles:
 * - null/undefined → 0
 * - Buffer → .length
 * - ArrayBuffer → .byteLength
 * - TypedArray (Uint8Array, etc.) → .byteLength
 * - string → UTF-8 byte length
 * - objects/arrays → JSON.stringify UTF-8 byte length
 * - Circular refs, BigInt, functions → 0 (fail-open, don't break IPC)
 */
export function estimatePayloadSize(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (Buffer.isBuffer(value)) return value.length;
  if (value instanceof SharedArrayBuffer) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf-8');
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf-8');
  } catch {
    // Non-serializable (circular refs, BigInt, functions) — fail-open
    return 0;
  }
}

/**
 * Record a violation if the payload exceeds thresholds.
 *
 * No-op when `REBEL_E2E_PERF_MODE` is not set — zero overhead in production.
 */
export function recordIfOversized(channel: string, result: unknown): void {
  if (!IS_PERF_MODE) return;
  const size = estimatePayloadSize(result);
  if (size > FAIL_THRESHOLD) {
    violations.push({ channel, size, level: 'fail', timestamp: Date.now() });
  } else if (size > WARN_THRESHOLD) {
    violations.push({ channel, size, level: 'warn', timestamp: Date.now() });
  }
}

/** Return a shallow copy of all recorded violations. */
export function getViolations(): PayloadViolation[] {
  return [...violations];
}

/** Clear all recorded violations. */
export function clearViolations(): void {
  violations.length = 0;
}
