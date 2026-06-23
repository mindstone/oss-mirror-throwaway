import { createScopedLogger, getTurnContext } from '@core/logger';
import { turnObservability } from '@core/services/turnObservability';
import type { RetryInfo } from '../modelClient';

const log = createScopedLogger({ service: 'rebelCoreRetryTelemetry' });

export type RetryTelemetryCallsite =
  | 'planner'
  | 'executor'
  | 'fallback-executor'
  | 'skeleton-executor'
  | 'sub-agent';

type RetryTelemetryInfo = Omit<RetryInfo, 'errorKind'> & { errorKind?: unknown };

export function isRateLimitRetryKind(errorKind: unknown): boolean {
  if (typeof errorKind !== 'string') return false;
  const lower = errorKind.toLowerCase();
  return lower === 'rate_limit' || lower.includes('429');
}

const normalizeRetryErrorKind = (errorKind: unknown): string =>
  (typeof errorKind === 'string' && errorKind.trim().length > 0) ? errorKind : 'unknown';

export const logProviderRetryTelemetry = (
  retry: RetryTelemetryInfo,
  callsite: RetryTelemetryCallsite,
): void => {
  const { attempt, maxRetries, provider, delayMs, errorKind } = retry;
  const normalizedErrorKind = normalizeRetryErrorKind(errorKind);

  log.warn(
    { attempt, maxRetries, provider, errorKind: normalizedErrorKind, delayMs, callsite },
    'provider:retry-attempt',
  );

  // Per-turn reliability observation (thin slice): count the PRIMARY turn's own
  // app-level (`runWithRetry`) retries — planner/executor/fallback/skeleton — and
  // EXCLUDE sub-agent retries, which inherit the parent turn's AsyncLocalStorage
  // context (`getTurnContext()`) and would otherwise inflate the parent's count.
  // Sub-agent amplification is a separate, deferred dimension (open decision #2;
  // see the PLAN Appendix). This is the scope-aware chokepoint all onRetry
  // consumers funnel through.
  if (callsite !== 'sub-agent') {
    turnObservability.recordAppRetry(getTurnContext()?.turnId);
  }

  if (isRateLimitRetryKind(errorKind)) {
    log.warn(
      { attempt, maxRetries, provider, callsite },
      'provider:rate-limit-429',
    );
  }
};
