import { ModelError } from './modelErrors';
import {
  recordContextOverflowOnProfile,
  recordOutputCapOnProfile,
  type WriteResult,
} from './learnedProfileWriter';

export interface LearnedLimitsDispatchContext {
  turnId: string;
  model: string;
  profileId: string | null;
}

export interface LearnedLimitsDispatchLogger {
  warn: (payload: { error: unknown }, message: string) => void;
}

const DISPATCH_CACHE_SYMBOL: unique symbol = Symbol('learnedLimitsDispatchResult');

type DispatchCacheValue = WriteResult | null;

function getCachedResult(err: ModelError): DispatchCacheValue | undefined {
  return (err as ModelError & { [DISPATCH_CACHE_SYMBOL]?: DispatchCacheValue })[DISPATCH_CACHE_SYMBOL];
}

function setCachedResult(err: ModelError, value: DispatchCacheValue): void {
  Object.defineProperty(err, DISPATCH_CACHE_SYMBOL, {
    value,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const floor = Math.floor(value);
  return floor > 0 ? floor : undefined;
}

function extractOverflowTokens(value: unknown): number | undefined {
  const direct = parsePositiveInt(value);
  if (direct) return direct;
  if (!value || typeof value !== 'object') return undefined;
  const rec = value as Record<string, unknown>;
  return parsePositiveInt(rec.lastKnownInputTokens)
    ?? parsePositiveInt(rec.observedTokens)
    ?? parsePositiveInt(rec.lastKnownTokens);
}

/**
 * Centralized learned-limits dispatcher.
 *
 * Routes structured `ModelError.details` to the relevant profile writer:
 * - `details.contextOverflow` -> `recordContextOverflowOnProfile` (no result)
 * - `details.outputCap` -> `recordOutputCapOnProfile` (returns WriteResult)
 * - neither detail -> no-op (`null`)
 *
 * The result is memoized on the error instance so repeated calls from multiple
 * catch sites in the same error path remain idempotent.
 */
export function dispatchLearnedLimitsFromError(
  err: unknown,
  ctx: LearnedLimitsDispatchContext,
): WriteResult | null {
  if (!(err instanceof ModelError)) return null;

  const cached = getCachedResult(err);
  if (cached !== undefined) return cached;

  const overflowTokens = extractOverflowTokens(err.details?.contextOverflow);
  if (overflowTokens) {
    recordContextOverflowOnProfile({
      model: ctx.model,
      profileId: ctx.profileId,
      lastKnownInputTokens: overflowTokens,
    });
    setCachedResult(err, null);
    return null;
  }

  const outputCap = parsePositiveInt(err.details?.outputCap);
  if (!outputCap) {
    setCachedResult(err, null);
    return null;
  }

  const writeResult = recordOutputCapOnProfile({
    model: ctx.model,
    profileId: ctx.profileId,
    observedCap: outputCap,
  });
  setCachedResult(err, writeResult);
  return writeResult;
}

/**
 * Safe dispatcher wrapper for catch blocks that must preserve the original
 * provider error even if learned-limit side effects fail unexpectedly.
 */
export function safeDispatchLearnedLimitsFromError(
  err: unknown,
  ctx: LearnedLimitsDispatchContext,
  logger: LearnedLimitsDispatchLogger,
): WriteResult | null {
  try {
    return dispatchLearnedLimitsFromError(err, ctx);
  } catch (error) {
    logger.warn({ error }, 'dispatchLearnedLimitsFromError threw — preserving original error');
    return null;
  }
}
