/**
 * Session Approvals Storage
 *
 * Single-use approval storage for safety domains.
 * Single-use approvals are consumed on first check and removed.
 * Used for "Allow once" behavior where user wants to approve exactly one retry.
 *
 * Execution-expectation tracking (Stage 2, FOX-2771/2601 post-approval guard):
 * legacy (non-staged) approval flows store a single-use approval and rely on a
 * model-mediated "please re-run" continuation — nothing used to verify the
 * approved operation actually ran. Call sites that expect a follow-up
 * execution opt in via `expectExecution: true`; the approval-execution guard
 * Stop hook (`approvalExecutionGuardHook.ts`) reads the unconsumed
 * expectations at turn end and forces exactly one stronger continuation.
 */

import { createScopedLogger } from '@core/logger';
import type { SafetyDomain } from './types';

const logger = createScopedLogger({ service: 'sessionApprovals' });

/**
 * Normalize identifier for storage/lookup.
 * For 'memory' domain (file paths), normalize to lowercase for case-insensitive matching
 * since macOS filesystem is case-insensitive but case-preserving.
 * Tool identifiers remain case-sensitive.
 */
function normalizeIdentifier(domain: SafetyDomain, identifier: string): string {
  if (domain === 'memory') {
    // macOS filesystem is case-insensitive, so normalize paths to lowercase
    // This prevents "/path/Mindstone/file.md" and "/path/mindstone/file.md" from being treated as different
    return identifier.toLowerCase();
  }
  return identifier;
}

interface SingleUseApprovalRecord {
  /** Original (un-normalized) identifier — used for user/model-facing messages. */
  identifier: string;
  /**
   * Monotonic per-process store sequence. Used (instead of wall-clock
   * `storedAt`) for the "stored before this turn started" boundary so a fast
   * approve-then-turn-start landing in the same millisecond cannot be
   * misclassified as mid-turn (GPT review F3).
   */
  seq: number;
  /** Wall-clock store time — used only for the surfaced-record staleness sweep. */
  storedAt: number;
  /**
   * True when the approval flow sends a "please re-run" continuation and the
   * operation is therefore EXPECTED to execute (legacy tool/memory approvals).
   * False for staged flows (already executed deterministically) and call sites
   * that don't promise a retry.
   */
  expectExecution: boolean;
  /** Set when the approval-execution guard has already forced its one follow-up continuation. */
  forcedContinuationAt?: number;
  /** Set when the "approved but not executed" state has been surfaced to the user. */
  surfacedAt?: number;
}

// Single-use approvals: domain -> sessionId -> normalizedIdentifier -> record
// These are consumed on first check and removed
const singleUseApprovals = new Map<SafetyDomain, Map<string, Map<string, SingleUseApprovalRecord>>>();

// Monotonic sequence stamped on every stored approval. Snapshot it at turn
// start via `currentApprovalSequence()`; records with `seq <= snapshot` were
// stored before the turn started.
let approvalSeqCounter = 0;

/**
 * Current value of the monotonic approval-store sequence. Snapshot at turn
 * start and pass to {@link listUnconsumedExecutionExpectations} /
 * {@link hasActionableExecutionExpectations} as the stored-before boundary.
 */
export function currentApprovalSequence(): number {
  return approvalSeqCounter;
}

/**
 * Staleness sweep (GPT review F4): surfaced-but-never-retried execution
 * expectations older than this are dropped — record AND approval — the next
 * time the expectation store is queried. A single-use approval whose
 * "approved but not executed" state was surfaced a day ago should not stay
 * live indefinitely; re-approval is the safe path after that long.
 */
const SURFACED_RECORD_TTL_MS = 24 * 60 * 60 * 1000;

// =============================================================================
// Single-Use Approvals (consumed on first check)
// =============================================================================

/**
 * Store a single-use approval for a session.
 * This approval will be consumed (removed) on the first check.
 * Used for "Allow once" behavior where user wants to approve exactly one retry.
 *
 * @param domain - The safety domain ('tool' or 'memory')
 * @param sessionId - The session ID
 * @param identifier - The operation identifier (tool name, space path, etc.)
 * @param opts.expectExecution - Opt-in flag: the caller sends a retry
 *   continuation and the approved operation is expected to execute (see
 *   {@link listUnconsumedExecutionExpectations}). Defaults to false so
 *   un-audited call sites never trigger the guard.
 */
export function storeSingleUseApproval(
  domain: SafetyDomain,
  sessionId: string,
  identifier: string,
  opts?: { expectExecution?: boolean }
): void {
  const normalizedId = normalizeIdentifier(domain, identifier);
  if (!singleUseApprovals.has(domain)) {
    singleUseApprovals.set(domain, new Map());
  }
  const domainMap = singleUseApprovals.get(domain);
  if (!domainMap) return;

  if (!domainMap.has(sessionId)) {
    domainMap.set(sessionId, new Map());
  }
  approvalSeqCounter += 1;
  domainMap.get(sessionId)?.set(normalizedId, {
    identifier,
    seq: approvalSeqCounter,
    storedAt: Date.now(),
    expectExecution: opts?.expectExecution ?? false,
  });

  logger.info(
    { domain, sessionId, identifier, normalizedId, expectExecution: opts?.expectExecution ?? false },
    'Stored single-use approval'
  );
}

/**
 * Check and consume a single-use approval.
 * If an approval exists, it is removed and true is returned.
 * If no approval exists, false is returned.
 *
 * @param domain - The safety domain ('tool' or 'memory')
 * @param sessionId - The session ID
 * @param identifier - The operation identifier (tool name, space path, etc.)
 * @returns true if approval was consumed, false if no approval existed
 */
export function consumeSingleUseApproval(
  domain: SafetyDomain,
  sessionId: string,
  identifier: string
): boolean {
  const normalizedId = normalizeIdentifier(domain, identifier);
  const domainMap = singleUseApprovals.get(domain);
  const identifiers = domainMap?.get(sessionId);

  if (identifiers?.has(normalizedId)) {
    identifiers.delete(normalizedId);
    logger.info({ domain, sessionId, identifier, normalizedId }, 'Consumed single-use approval');
    return true;
  }
  return false;
}

/**
 * Clear all single-use approvals for a specific session across all domains.
 * Call this when a session ends to prevent memory leaks.
 *
 * @param sessionId - The session ID to clear
 */
export function clearSessionSingleUseApprovals(sessionId: string): void {
  for (const [domain, domainMap] of singleUseApprovals.entries()) {
    if (domainMap.has(sessionId)) {
      const count = domainMap.get(sessionId)?.size ?? 0;
      domainMap.delete(sessionId);
      if (count > 0) {
        logger.debug({ domain, sessionId, count }, 'Cleared single-use approvals for session');
      }
    }
  }
}

// =============================================================================
// Execution-expectation queries (approval-execution guard support)
// =============================================================================

export interface UnconsumedExecutionExpectation {
  domain: SafetyDomain;
  /** Original (un-normalized) identifier for user/model-facing messages. */
  identifier: string;
  storedAt: number;
  forcedContinuationAt?: number;
  surfacedAt?: number;
}

/**
 * List approvals for a session that (a) opted into execution expectation,
 * (b) have NOT been consumed (the approved operation never ran), and
 * (c) were stored at-or-before the `storedBeforeSeq` sequence snapshot —
 * i.e. before the current turn started, so the turn under inspection was
 * supposed to consume them. Take the snapshot with
 * {@link currentApprovalSequence} at turn start.
 *
 * Side effect: prunes surfaced records older than {@link SURFACED_RECORD_TTL_MS}
 * (the staleness sweep runs at this access point).
 */
export function listUnconsumedExecutionExpectations(
  sessionId: string,
  storedBeforeSeq: number
): UnconsumedExecutionExpectation[] {
  const out: UnconsumedExecutionExpectation[] = [];
  const now = Date.now();
  for (const [domain, domainMap] of singleUseApprovals.entries()) {
    const records = domainMap.get(sessionId);
    if (!records) continue;
    for (const [normalizedId, record] of records.entries()) {
      if (!record.expectExecution) continue;
      // Staleness sweep: surfaced-but-never-retried records expire after TTL.
      if (record.surfacedAt !== undefined && now - record.surfacedAt > SURFACED_RECORD_TTL_MS) {
        records.delete(normalizedId);
        logger.info(
          { domain, sessionId, identifier: record.identifier },
          'Pruned stale surfaced execution expectation (TTL elapsed)'
        );
        continue;
      }
      if (record.seq > storedBeforeSeq) continue;
      out.push({
        domain,
        identifier: record.identifier,
        storedAt: record.storedAt,
        ...(record.forcedContinuationAt !== undefined
          ? { forcedContinuationAt: record.forcedContinuationAt }
          : {}),
        ...(record.surfacedAt !== undefined ? { surfacedAt: record.surfacedAt } : {}),
      });
    }
  }
  return out;
}

/**
 * True when at least one execution-expected approval stored at-or-before the
 * `storedBeforeSeq` snapshot is still unconsumed AND has not yet been
 * SURFACED — i.e. the approval-execution guard still has work to do at the
 * next stop: either its single forced continuation, or the "approved but not
 * executed" surfacing pass that follows it. The task-board
 * forced-continuation layer in `rebelCoreQuery` consults this (via an
 * injected predicate) to surrender its generic continuation so the Stop-hook
 * chain runs (GPT review F1 + confirm-round F1).
 *
 * Deliberately keyed on `surfacedAt`, NOT `forcedContinuationAt`: if the
 * predicate flipped false as soon as the forced budget was spent, a model
 * that ignores the approval-specific continuation while main-agent tasks
 * remain pending would let the generic task-board injection preempt every
 * remaining Stop-hook pass — the guard's surfacing leg would never run
 * (confirm-round must-address). Keying on surfaced bounds task-board
 * starvation at TWO yields per approval (one forced continuation, one
 * surfacing pass); after surfacing or consumption the predicate goes false
 * and normal task-board behavior resumes.
 */
export function hasActionableExecutionExpectations(
  sessionId: string,
  storedBeforeSeq: number
): boolean {
  return listUnconsumedExecutionExpectations(sessionId, storedBeforeSeq).some(
    (p) => p.surfacedAt === undefined
  );
}

/**
 * Mark that the approval-execution guard has spent its single forced
 * continuation for this approval. Idempotent; missing records are ignored
 * (consumed in a race — the good outcome).
 */
export function markExecutionExpectationForced(
  domain: SafetyDomain,
  sessionId: string,
  identifier: string
): void {
  const record = singleUseApprovals
    .get(domain)
    ?.get(sessionId)
    ?.get(normalizeIdentifier(domain, identifier));
  if (record && record.forcedContinuationAt === undefined) {
    record.forcedContinuationAt = Date.now();
  }
}

/**
 * Mark that the "approved but not executed" terminal state has been surfaced
 * for this approval, so the guard never re-surfaces it on later turns. The
 * approval itself is intentionally NOT removed — a later manual retry can
 * still consume it.
 */
export function markExecutionExpectationSurfaced(
  domain: SafetyDomain,
  sessionId: string,
  identifier: string
): void {
  const record = singleUseApprovals
    .get(domain)
    ?.get(sessionId)
    ?.get(normalizeIdentifier(domain, identifier));
  if (record && record.surfacedAt === undefined) {
    record.surfacedAt = Date.now();
  }
}

// Exposed for testing only — resets all single-use approvals between test cases.
// eslint-disable-next-line @typescript-eslint/naming-convention -- `_testing_` prefix is the convention for test-only public hooks
export const _testing_resetSingleUseApprovals = (): void => {
  singleUseApprovals.clear();
  approvalSeqCounter = 0;
};
