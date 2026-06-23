import type { AbortReason } from '@core/services/diagnostics/manifest';

// NOTE: this vocabulary is duplicated as zod enums in
// `src/core/services/diagnosticEventsLedger.ts` (FAILURE_REASON) and
// `src/core/services/diagnostics/manifest.ts` (DiagnosticFailureReason).
// Keep all three in sync when adding a reason.
export type FailureReason =
  | 'provider_error'
  | 'network'
  | 'timeout'
  | 'parse_error'
  | 'tool_loop'
  // Model output was cut off at the token cap (stop_reason: max_tokens) before a
  // usable result could be parsed — e.g. context-state compaction overrunning its
  // output budget. Distinct from `parse_error` (malformed output) so the cost
  // ledger / Usage page can attribute these honestly instead of as `other`.
  | 'truncated'
  | 'other';

export type TurnOutcome =
  | { kind: 'success' }
  | { kind: 'aborted'; reason: AbortReason }
  | { kind: 'quota' }
  | { kind: 'safety_eval_rejected'; stage: 'pre' | 'post' }
  | { kind: 'tool_budget' }
  | { kind: 'failed'; reason: FailureReason }
  | { kind: 'auxiliary_success' }
  | { kind: 'auxiliary_failed'; reason: FailureReason }
  | { kind: 'legacy_unknown' };

export const FAILURE_REASONS: readonly FailureReason[] = [
  'provider_error',
  'network',
  'timeout',
  'parse_error',
  'tool_loop',
  'truncated',
  'other',
] as const;

const ABORT_REASONS: readonly AbortReason[] = [
  'user_cancel',
  'superseded',
  'watchdog',
  'judge_killed',
  'consecutive_fail_open_cap',
  'tool_cancelled_cap',
  'tool_cancel_unresponsive',
  'tool_repeated_timeout',
  'budget_hard',
  'budget_soft',
  'shutdown',
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isOneOf = <T extends string>(value: unknown, values: readonly T[]): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

export function isTurnOutcome(value: unknown): value is TurnOutcome {
  if (!isRecord(value)) return false;

  switch (value.kind) {
    case 'success':
    case 'quota':
    case 'tool_budget':
    case 'auxiliary_success':
    case 'legacy_unknown':
      return true;
    case 'aborted':
      return isOneOf(value.reason, ABORT_REASONS);
    case 'safety_eval_rejected':
      return value.stage === 'pre' || value.stage === 'post';
    case 'failed':
    case 'auxiliary_failed':
      return isOneOf(value.reason, FAILURE_REASONS);
    default:
      return false;
  }
}

export function classifyFailureReason(error: unknown): FailureReason {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const lower = message.toLowerCase();

  if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
  if (
    lower.includes('network') ||
    lower.includes('econnreset') ||
    lower.includes('enotfound') ||
    lower.includes('fetch failed')
  ) {
    return 'network';
  }
  if (
    lower.includes('parse') ||
    lower.includes('json') ||
    lower.includes('empty_result_anomaly') ||
    lower.includes('empty result')
  ) {
    return 'parse_error';
  }
  if (lower.includes('tool loop') || lower.includes('tool budget')) return 'tool_loop';
  if (
    lower.includes('provider') ||
    lower.includes('api error') ||
    lower.includes('server error') ||
    lower.includes('5xx') ||
    lower.includes('rate limit')
  ) {
    return 'provider_error';
  }
  return 'other';
}

export function classifyTurnOutcomeFromError(error: unknown): TurnOutcome {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const lower = message.toLowerCase();

  if (
    lower.includes('quota') ||
    lower.includes('billing') ||
    lower.includes('insufficient_quota') ||
    lower.includes('exceeded your current quota')
  ) {
    return { kind: 'quota' };
  }
  if (lower.includes('tool budget') || lower.includes('hard budget')) {
    return { kind: 'tool_budget' };
  }
  return { kind: 'failed', reason: classifyFailureReason(error) };
}
