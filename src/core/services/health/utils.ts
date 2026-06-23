/**
 * Health Check Utilities
 */

import { createScopedLogger } from '@core/logger';
import type { CheckResult } from './types';
import { appendDiagnosticEvent } from '../diagnosticEventsLedger';
import { hashHealthCheckId } from '../diagnostics/eventHashing';
import { HEALTH_CHECK_TIMEOUT_MS, HEALTH_CHECK_SLOW_THRESHOLD_MS } from '../diagnostics/manifest';

const log = createScopedLogger({ service: 'healthCheck' });

function bucketHealthCheckDurationMs(durationMs: number): 500 | 1000 | 5000 | 30000 {
  if (durationMs <= 500) return 500;
  if (durationMs <= 1000) return 1000;
  if (durationMs <= 5000) return 5000;
  return 30000;
}

/**
 * Wrap a check function to ensure it never throws - returns error result on failure.
 * Also enforces a timeout and emits a health_check_timing event if slow or timed out.
 * checkFn receives an AbortSignal; checks doing I/O SHOULD pass it to underlying
 * APIs so background work stops when the outer timeout fires.
 */
export async function safeCheck<T extends CheckResult>(
  checkFn: (signal: AbortSignal) => T | Promise<T>,
  fallbackId: string,
  fallbackName: string,
  options?: { timeoutMs?: number }
): Promise<CheckResult> {
  const timeoutMs = options?.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
  const startTime = Date.now();
  
  let result: CheckResult;
  let isTimeout = false;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const checkPromise = Promise.resolve().then(() => checkFn(controller.signal));
    const timeoutPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new Error(`Health check timed out after ${timeoutMs}ms`));
      });
    });

    result = await Promise.race([checkPromise, timeoutPromise]);
    clearTimeout(timeoutId);
  } catch (error) {
    if (error instanceof Error && error.message.includes('timed out after')) {
      isTimeout = true;
      result = {
        id: fallbackId,
        name: fallbackName,
        status: 'fail',
        message: 'Check timed out',
        details: { error: error.message },
        timedOut: true,
      } as CheckResult;
    } else {
      log.warn({ err: error, checkId: fallbackId }, 'Health check threw unexpectedly');
      result = {
        id: fallbackId,
        name: fallbackName,
        status: 'warn',
        message: 'Check failed unexpectedly',
        details: { error: error instanceof Error ? error.message : String(error) },
      } as CheckResult;
    }
  }

  const durationMs = Date.now() - startTime;
  result.durationMs = durationMs;

  if (isTimeout || durationMs > HEALTH_CHECK_SLOW_THRESHOLD_MS) {
    appendDiagnosticEvent({
      kind: 'health_check_timing',
      data: {
        checkIdHash: hashHealthCheckId(result.id),
        durationBucketMs: bucketHealthCheckDurationMs(durationMs),
        status: result.status,
        ...(isTimeout ? { timedOut: true } : {}),
      },
    });
  }

  return result;
}
