import type { SafetyEvalResult } from '@core/safetyPromptTypes';
import type { SessionKind } from '@shared/sessionKind';

export type FailClosedClassification = 'policy' | 'infra' | 'rate-limited' | null;

export type FailClosedDisposition = 'ask_local' | 'ask_remote' | 'stage_for_later';

const STAGE_FOR_LATER_KINDS: ReadonlySet<SessionKind> = new Set([
  'meeting-companion',
  'automation',
  'automation-insight',
  'meeting-analysis',
  'use-case-discovery',
  'memory-update',
  'meeting-qa',
  'error-eval',
  'calendar-sync',
]);

/**
 * Classifies a SafetyEvalResult for fail-closed policy routing.
 *
 * Note: we intentionally do not expose an "aborted" category here. Abort is
 * surfaced as a thrown AbortError/catch path, not as a returned SafetyEvalResult.
 */
export function classifyFailClosed(result: SafetyEvalResult): FailClosedClassification {
  if (result.failClosed !== true) {
    return result.decision === 'block' ? 'policy' : null;
  }

  return result.failClosedReason === 'rate-limited' ? 'rate-limited' : 'infra';
}

interface ResolveFailClosedDispositionArgs {
  sessionKind: SessionKind;
  hasApprovalHandler: boolean;
}

/**
 * Resolves how fail-closed side-effecting actions should be handled.
 *
 * Hard rule: automation/background/companion kinds always stage for later,
 * even if an approval handler exists.
 */
export function resolveFailClosedDisposition(
  args: ResolveFailClosedDispositionArgs,
): FailClosedDisposition {
  const { sessionKind, hasApprovalHandler } = args;

  if (STAGE_FOR_LATER_KINDS.has(sessionKind)) {
    return 'stage_for_later';
  }

  if (sessionKind === 'conversation' && hasApprovalHandler !== true) {
    return 'ask_local';
  }

  if (hasApprovalHandler) {
    return 'ask_remote';
  }

  return 'stage_for_later';
}
