/**
 * Agent Turn Cleanup
 *
 * Cleanup orchestration for agent turns. Handles:
 * - Turn logger finalization and flushing
 * - Synthetic result construction for abort/error paths
 * - Proxy route removal (council, ad-hoc)
 * - Cost ledger entries for multi-model turns
 * - Registry state cleanup (prevents memory leaks)
 *
 * Extracted from agentTurnExecutor.ts (Stage 2 hardening).
 */

import type { EventWindow } from '@core/types';
import type { TurnEndReason } from '@shared/types';
import { logger } from '@core/logger';
import { calculateCostOrWarn } from '@shared/utils/pricingCalculator';
import { agentTurnRegistry } from './agentTurnRegistry';
import { dispatchAgentEvent } from './agentEventDispatcher';
import { proxyManager } from './localModelProxyServer';
import { appendCostEntry } from './costLedgerService';
import { releaseBlock } from './powerSaveBlockerService';
import { cleanupTurnAggregator } from '../tracking';
import { cleanupPendingApprovals } from './toolSafetyService';
import { cleanupAutoContinueCache } from './autoContinueCache';
import { clearCheckpointLockedState } from './safety/memoryWriteHook';
import { getTurnCheckpointManager } from '@core/services/turnCheckpointService';
import { turnObservability } from '@core/services/turnObservability';

type TurnCleanupKey = import('./turnPipeline/cleanupTypes').TurnCleanupKey;
type AttemptCleanupFnsRecord = import('./turnPipeline/cleanupTypes').AttemptCleanupFnsRecord;
type TerminalCleanupFnsRecord = import('./turnPipeline/cleanupTypes').TerminalCleanupFnsRecord;

// ─── Turn Tracking State ────────────────────────────────────────────────────
// Mutable state shared between the executor (writes during setup) and cleanup
// (reads/deletes during teardown). The executor imports and mutates these
// directly: e.g. `councilTurnIds.add(turnId)`.

/** Track which turns activated council mode (for proxy cleanup) */
export const councilTurnIds = new Set<string>();

/** Track which turns activated ad-hoc model dispatch (for proxy cleanup) */
export const adHocTurnIds = new Set<string>();

/**
 * Per-turn ad-hoc metadata.
 * Tracks state needed for ad-hoc stats logging and failure attribution.
 */
export interface AdHocTurnMeta {
  /** Map of model name → human-readable profile display name */
  modelDisplayNames: Map<string, string>;
  /** EventWindow reference for dispatching status events during cleanup */
  win: EventWindow | null;
}

/**
 * Per-turn council metadata.
 * Tracks state needed for council stats logging and failure attribution:
 * - Model→profile display name mapping (for user-facing failure messages)
 * - EventWindow ref for dispatching status events during cleanup
 */
export interface CouncilTurnMeta {
  /** Map of model name → human-readable profile display name (for failure messages) */
  modelDisplayNames: Map<string, string>;
  /** EventWindow reference for dispatching status events during cleanup */
  win: EventWindow | null;
}

export const councilTurnMeta = new Map<string, CouncilTurnMeta>();
export const adHocTurnMeta = new Map<string, AdHocTurnMeta>();

/**
 * Live-attempt-epoch registry for the pre-dispatch liveness guard + cleanup
 * idempotency (260619_turn-hang-bugmode Stage 2, rework-final-F3).
 *
 * ONE per-turn entry holds the CURRENT live attempt's epoch and its pre-dispatch
 * guard disarm callback. This single structure replaces both the old turn-keyed
 * disarm map and the old (evictable, FIFO) completion-marker set — it is the
 * by-construction enforcement of the strong invariant:
 *
 *   **A stale OLD attempt can NEVER affect a same-`turnId` retry.**
 *
 * `completeTurnCleanup(turnId, reason, attemptEpoch)` no-ops ENTIRELY (no disarm,
 * no `cleanupTurnAttempt`, no proxy/registry/cost-ledger teardown) unless
 * `attemptEpoch` equals the turn's CURRENT live epoch. Because the executor
 * captures a fresh process-wide-monotonic epoch per `executeAgentTurn` invocation
 * and `beginTurnAttempt()` overwrites the live epoch on each (re-)entry, a stale
 * continuation from a dead-mount fs read — resuming after an ARBITRARY delay,
 * even after thousands of later completions — carries an epoch that no longer
 * matches and is rejected with zero side effects. No time/count window exists
 * (the old FIFO eviction had one); no turn-keyed disarm side effect precedes the
 * epoch check (the old ordering bug had one).
 *
 * Legacy/cross-module 2-arg callers (`turnErrorRecovery`, `turnCompletion`) pass
 * NO epoch. They run on the turn's error/terminal path which is mutually
 * exclusive (per attempt) with the executor's own cleanup, and they operate on
 * the LIVE attempt by definition (the turn is still the current attempt when they
 * fire). A 2-arg call matches the live attempt (proceeds against whatever the
 * live entry is, or falls through when no entry was ever registered) so their
 * existing once-per-turn semantics are preserved; only an epoch-bearing call from
 * a stale OLD attempt is rejected. (The match logic is inlined in
 * `completeTurnCleanup`'s gate.)
 */
interface LiveTurnAttempt {
  liveEpoch: number;
  disarm?: () => void;
  /** Set once this live attempt has run terminal cleanup, so a re-entrant call for the SAME live attempt no-ops. */
  cleaned: boolean;
}
const liveTurnAttempts = new Map<string, LiveTurnAttempt>();

/**
 * Mark the start of a turn attempt: records its epoch as the turn's live epoch
 * (overwriting any prior attempt's) and clears the cleaned flag. Called by the
 * executor right after it arms the pre-dispatch guard for the attempt. Returns
 * nothing; pair with `registerPreDispatchGuardDisarm`.
 */
export function beginTurnAttempt(turnId: string, attemptEpoch: number): void {
  liveTurnAttempts.set(turnId, { liveEpoch: attemptEpoch, cleaned: false });
}

/**
 * Register the executor's pre-dispatch-guard disarm callback for the CURRENT live
 * attempt of `turnId`. No-ops if `attemptEpoch` is not the live epoch (a stale
 * old attempt must never overwrite the live attempt's disarm callback).
 */
export function registerPreDispatchGuardDisarm(turnId: string, attemptEpoch: number, disarm: () => void): void {
  const entry = liveTurnAttempts.get(turnId);
  if (!entry || entry.liveEpoch !== attemptEpoch) return;
  entry.disarm = disarm;
}

/** Invoke + forget the LIVE attempt's pre-dispatch-guard disarm for `turnId`. */
function disarmPreDispatchGuard(turnId: string): void {
  const entry = liveTurnAttempts.get(turnId);
  const disarm = entry?.disarm;
  if (!entry || !disarm) return;
  entry.disarm = undefined;
  try {
    disarm();
  } catch (err) {
    logger.warn({ turnId, err }, 'disarmPreDispatchGuard: disarm callback threw — continuing');
  }
}

/**
 * Test-only reset for the live-attempt registry. NOT for production use.
 */
export function __resetCompletedTurnGuardForTests(): void {
  liveTurnAttempts.clear();
}

// ─── Turn Lifecycle Helpers ─────────────────────────────────────────────────

/**
 * Finalize and cleanup turn logger after turn completion.
 */
export const finalizeTurnLogger = (turnId: string, reason: string): void => {
  const preserveAccumulator = agentTurnRegistry.hasUserQuestionPending(turnId);
  const turnLogger = agentTurnRegistry.getTurnLogger(turnId);
  if (!turnLogger) {
    cleanupTurnAggregator(turnId);
    if (!preserveAccumulator) {
      agentTurnRegistry.deleteContextAccumulator(turnId);
    }
    cleanupPendingApprovals(turnId);
    cleanupAutoContinueCache(turnId);
    return;
  }
  agentTurnRegistry.deleteTurnLogger(turnId);
  cleanupTurnAggregator(turnId);
  if (!preserveAccumulator) {
    agentTurnRegistry.deleteContextAccumulator(turnId);
  }
  cleanupPendingApprovals(turnId);
  cleanupAutoContinueCache(turnId);
  const sessionLogPath = turnLogger.sessionLogPath;
  turnLogger.flushSessionLogs().catch((error) => {
    logger.error({ err: error, turnId, sessionLogPath }, 'Failed to flush session log');
  });
  logger.info({ turnId, sessionLogPath, reason }, 'Agent turn session log finalized');
};

/**
 * Build a synthetic result event for abort/error/fallback paths.
 * Includes the model from the turn registry so analytics can attribute the turn
 * even when the runtime didn't produce a normal result message. (FOX-2871)
 *
 * All NEW callers should pass turnEndReason. See docs/plans/260415_silent_stop_detection_improvement.md
 */
export const makeSyntheticResult = (turnId: string, text = '', turnEndReason?: TurnEndReason) => ({
  type: 'result' as const,
  text,
  model: agentTurnRegistry.getTurnModel(turnId) ?? undefined,
  timestamp: Date.now(),
  isSynthetic: true as const,
  ...(turnEndReason ? { turnEndReason } : {}),
});

// ─── Per-attempt cleanup helpers (Stage 3) ──────────────────────────────────

/** Drop council registry entries if present. */
export function cleanupCouncilState(turnId: string): void {
  if (!councilTurnIds.has(turnId) && !councilTurnMeta.has(turnId)) return;
  councilTurnIds.delete(turnId);
  councilTurnMeta.delete(turnId);
}

/** Drop ad-hoc registry entries if present. */
export function cleanupAdHocState(turnId: string): void {
  if (!adHocTurnIds.has(turnId) && !adHocTurnMeta.has(turnId)) return;
  adHocTurnIds.delete(turnId);
  adHocTurnMeta.delete(turnId);
}

/** Remove any proxy routes registered for this turn. */
export function cleanupProxyRoutes(turnId: string): void {
  proxyManager.removeRoutes(turnId);
}

function cleanupRegisteredProxyRoutes(turnId: string): void {
  if (
    !councilTurnIds.has(turnId)
    && !councilTurnMeta.has(turnId)
    && !adHocTurnIds.has(turnId)
    && !adHocTurnMeta.has(turnId)
  ) {
    return;
  }
  cleanupProxyRoutes(turnId);
}

/**
 * Watchdog disposer placeholder. Stage 4 ships the actual disposer wiring
 * via a turn-keyed Map registered by `turnWatchdog.start(deps)`.
 */
export function cleanupWatchdogDisposer(_turnId: string): void {
  // Wired in Stage 4 (turnWatchdog).
}

/** Stop main-process turn checkpointing for this turnId. Synchronous + idempotent. */
export function cleanupCheckpointing(turnId: string): void {
  getTurnCheckpointManager()?.stopCheckpointing(turnId);
}

// ─── Terminal-only cleanup helpers (Stage 3) ────────────────────────────────

/** Release power-save blocker for this turn. Best-effort. */
export function cleanupSleepBlocker(turnId: string): void {
  try {
    releaseBlock(`turn:${turnId}`);
  } catch {
    // Power save blocker is best-effort
  }
}

/** Wipe all registry Maps for the turn. */
export function cleanupRegistryDeletion(turnId: string): void {
  agentTurnRegistry.cleanupTurn(turnId);
}

/** Finalize logger + clean checkpoint locked-state. Mirrors the pre-Stage-3 ordering. */
export function cleanupSessionEventFinalization(turnId: string): void {
  finalizeTurnLogger(turnId, _completionReasonForFinalize ?? 'completed');
  clearCheckpointLockedState(turnId);
}

/** Registry slot for future cost-ledger flush hooks. Current cost emission is the pre-read step. */
export function cleanupCostLedgerFlush(_turnId: string): void {
  // No-op. Cost-ledger emission happens before cleanupTurnAttempt.
}

/** Registry slot for future turn_completed dispatch unification. */
export function cleanupTurnCompletedEvent(_turnId: string): void {
  // No-op in Stage 3.
}

/** Registry slot for future per-turn error reporter scope cleanup. */
export function cleanupErrorReporterScope(_turnId: string): void {
  // No-op in Stage 3.
}

let _completionReasonForFinalize: string | undefined;

export const ATTEMPT_CLEANUP_FNS: AttemptCleanupFnsRecord = {
  councilTurnIds: cleanupCouncilState,
  councilTurnMeta: cleanupCouncilState,
  adHocTurnIds: cleanupAdHocState,
  adHocTurnMeta: cleanupAdHocState,
  proxyRoutes: cleanupRegisteredProxyRoutes,
  watchdogDisposer: cleanupWatchdogDisposer,
  turnCheckpointing: cleanupCheckpointing,
  sleepBlocker: null,
  registryDeletion: null,
  sessionEventFinalization: null,
  costLedgerFlush: null,
  turnCompletedEvent: null,
  errorReporterScope: null,
};

export const TERMINAL_CLEANUP_FNS: TerminalCleanupFnsRecord = {
  councilTurnIds: null,
  councilTurnMeta: null,
  adHocTurnIds: null,
  adHocTurnMeta: null,
  proxyRoutes: null,
  watchdogDisposer: null,
  turnCheckpointing: null,
  sessionEventFinalization: cleanupSessionEventFinalization,
  sleepBlocker: cleanupSleepBlocker,
  registryDeletion: cleanupRegistryDeletion,
  costLedgerFlush: cleanupCostLedgerFlush,
  turnCompletedEvent: cleanupTurnCompletedEvent,
  errorReporterScope: cleanupErrorReporterScope,
};

export const ALL_CLEANUP_KEYS: ReadonlyArray<TurnCleanupKey> = [
  'proxyRoutes',
  'councilTurnIds',
  'councilTurnMeta',
  'adHocTurnIds',
  'adHocTurnMeta',
  'watchdogDisposer',
  'turnCheckpointing',
  'sessionEventFinalization',
  'sleepBlocker',
  'registryDeletion',
  'costLedgerFlush',
  'turnCompletedEvent',
  'errorReporterScope',
];

export const cleanupTurnAttempt = (turnId: string): void => {
  // NOTE (rework-F3 final): attempt isolation lives entirely in the
  // `liveTurnAttempts` live-epoch registry consulted by `completeTurnCleanup`'s
  // gate — a stale OLD-attempt call no-ops there before ever reaching here, and a
  // retry's `beginTurnAttempt` makes its epoch authoritative. So this function
  // just runs the per-key cleanup fns; it deliberately holds no marker state of
  // its own (the prior evictable completion-marker set is gone — by construction,
  // not by eviction).
  for (const key of ALL_CLEANUP_KEYS) {
    const fn = ATTEMPT_CLEANUP_FNS[key];
    if (fn === null) continue;
    try {
      fn(turnId);
    } catch (err) {
      logger.warn({ key, turnId, err }, 'cleanupTurnAttempt: per-key cleanup threw — continuing');
    }
  }
};

/**
 * Complete turn cleanup - unified wrapper that ensures correct cleanup ordering.
 * MUST be called on all turn exit paths (success, error, abort, early returns).
 * 
 * Order matters:
 * 1. finalizeTurnLogger() - flushes logs, cleans aggregator/approvals/cache
 * 2. cleanupTurn() - cleans ALL registry Maps (was previously never called!)
 * 
 * This fixes memory leaks where 5+ Maps were never cleaned:
 * - turnEventListeners, turnExtendedContext, turnPrivateModes, turnCategories, autoContinueCounts
 */
export const completeTurnCleanup = (turnId: string, reason: string, attemptEpoch?: number): void => {
  // Live-attempt gate (260619_turn-hang-bugmode Stage 2, rework-final-F3) — the
  // by-construction enforcement of "a stale OLD attempt can NEVER affect a
  // same-turnId retry". This runs BEFORE every side effect, including disarm.
  //
  //   - Epoch-bearing call (from the executor): proceed ONLY if a live entry with
  //     a MATCHING epoch exists. A stale old-attempt continuation (resumed after a
  //     retry overwrote the live epoch, or after the turn terminated and the entry
  //     was deleted) finds a mismatch or no entry → no-ops ENTIRELY (no disarm, no
  //     cleanupTurnAttempt, no proxy/registry/cost teardown). There is NO
  //     eviction/time window: the live epoch is authoritative while the turn is
  //     live, and once it's gone, no epoch can match. Safe for an arbitrarily
  //     delayed dead-mount continuation.
  //   - 2-arg legacy/cross-module call (turnErrorRecovery/turnCompletion): no
  //     epoch. Proceeds against the live attempt (they fire on the live attempt's
  //     terminal/error path), or — for a turn that never registered an attempt
  //     (legacy/test paths) — falls through (underlying cleanup fns are no-ops on
  //     absent state).
  const entry = liveTurnAttempts.get(turnId);
  if (attemptEpoch !== undefined && (!entry || entry.liveEpoch !== attemptEpoch)) {
    logger.info({ turnId, reason, attemptEpoch, liveEpoch: entry?.liveEpoch }, 'completeTurnCleanup: stale old attempt — ignoring (live-epoch gate)');
    return;
  }
  // Re-entry within the SAME live attempt is idempotent: the first call marks the
  // entry cleaned; a second call for the same live attempt no-ops.
  if (entry?.cleaned) {
    logger.info({ turnId, reason, attemptEpoch }, 'completeTurnCleanup: already completed for this attempt — skipping (idempotent)');
    return;
  }
  // Disarm the pre-dispatch liveness guard (this is the live attempt's own guard).
  disarmPreDispatchGuard(turnId);

  // Per-turn reliability telemetry (dev's turn-observability thin slice, merged with
  // Stage 2). Placed AFTER the live-epoch gate above so only the LIVE attempt's
  // terminal emits (a stale old-attempt call already returned) and BEFORE the
  // registry teardown below so registry-sourced enrichment is still intact.
  // Idempotent + fail-open inside the service (emits at most once per turn; a
  // throwing tracker is logged, never propagated into turn teardown). Thin slice
  // emits only `reason` — NO registry enrichment reads (cross-family F1;
  // `resolvedModel` not PII-safe). See turnObservability.CompleteTurnInput + the
  // PLAN Appendix.
  turnObservability.completeTurn(turnId, { reason });
  // Step 0: Log council proxy stats BEFORE finalizing the turn logger so they appear in session logs.
  // Also surface partial council member failures to users.
  if (councilTurnIds.has(turnId)) {
    const stats = proxyManager.getAndResetTurnStats(turnId);
    const meta = councilTurnMeta.get(turnId);
    if (stats.size > 0) {
      const summary: Record<string, { inputTokens: number; outputTokens: number; requests: number; errors: number }> = {};
      for (const [model, s] of stats) {
        summary[model] = { inputTokens: s.inputTokens, outputTokens: s.outputTokens, requests: s.requestCount, errors: s.errorCount };
      }
      const totalErrors = [...stats.values()].reduce((sum, s) => sum + s.errorCount, 0);
      const totalTokens = [...stats.values()].reduce((sum, s) => sum + s.inputTokens + s.outputTokens, 0);
      const turnLogger = agentTurnRegistry.getTurnLogger(turnId);
      if (turnLogger) {
        turnLogger.info({ councilStats: summary, totalTokens, totalErrors }, 'Council proxy usage summary');
      } else {
        logger.info({ turnId, councilStats: summary, totalTokens, totalErrors }, 'Council proxy usage summary');
      }

      // Write council proxy costs to ledger only when the main turn did NOT
      // already record cost. agentMessageHandler records turn cost (including
      // sub-agent usage merged via mergeSubAgentUsage) and marks the flag.
      // Writing proxy stats on top of that would double-count the same tokens.
      if (reason.startsWith('completed') && !agentTurnRegistry.hasCostRecorded(turnId)) {
        for (const [model, s] of stats) {
          const cost = calculateCostOrWarn(
            model, s.inputTokens, s.outputTokens,
            turnLogger ?? logger, 'council-proxy',
          );
          if (cost == null || cost <= 0) continue;
          appendCostEntry({
            ts: Date.now(),
            cost,
            sid: agentTurnRegistry.getRendererSession(turnId),
            tid: turnId,
            cat: 'council',
            m: model,
            auth: agentTurnRegistry.getTurnAuthMethod(turnId),
            outcome: totalErrors > 0
              ? { kind: 'failed', reason: 'provider_error' }
              : { kind: 'success' },
          });
        }
      }

      // Surface partial council member failures to the user
      if (totalErrors > 0 && meta) {
        const failedMembers: string[] = [];
        for (const [model, s] of stats) {
          if (s.errorCount > 0) {
            const displayName = meta.modelDisplayNames.get(model) ?? model;
            failedMembers.push(displayName);
          }
        }
        if (failedMembers.length > 0) {
          const failedList = failedMembers.join(', ');
          const statusMsg = failedMembers.length === stats.size
            ? `Council: all members failed (${failedList}). Synthesis used lead model only.`
            : `Council: ${failedList} had errors. Synthesis used available responses.`;
          dispatchAgentEvent(meta.win, turnId, {
            type: 'status',
            message: statusMsg,
            timestamp: Date.now(),
          });
          const turnLogger = agentTurnRegistry.getTurnLogger(turnId);
          if (turnLogger) {
            turnLogger.warn({ failedMembers, totalErrors }, 'Council partial failure surfaced to user');
          }
        }
      }
    }
  }
  // Step 0b: Log ad-hoc model proxy stats (same pattern as council stats above).
  if (adHocTurnIds.has(turnId)) {
    const stats = proxyManager.getAndResetTurnStats(turnId);
    const meta = adHocTurnMeta.get(turnId);
    if (stats.size > 0) {
      const summary: Record<string, { inputTokens: number; outputTokens: number; requests: number; errors: number }> = {};
      for (const [model, s] of stats) {
        summary[model] = { inputTokens: s.inputTokens, outputTokens: s.outputTokens, requests: s.requestCount, errors: s.errorCount };
      }
      const totalTokens = [...stats.values()].reduce((sum, s) => sum + s.inputTokens + s.outputTokens, 0);
      const totalErrors = [...stats.values()].reduce((sum, s) => sum + s.errorCount, 0);
      const turnLogger = agentTurnRegistry.getTurnLogger(turnId);
      if (turnLogger) {
        turnLogger.info({ adHocStats: summary, totalTokens, totalErrors }, 'Ad-hoc model proxy usage summary');
      } else {
        logger.info({ turnId, adHocStats: summary, totalTokens, totalErrors }, 'Ad-hoc model proxy usage summary');
      }

      // Write ad-hoc proxy costs to ledger only when the main turn did NOT
      // already record cost. agentMessageHandler records turn cost (including
      // sub-agent usage merged via mergeSubAgentUsage) and marks the flag.
      // Writing proxy stats on top of that would double-count the same tokens.
      if (reason.startsWith('completed') && !agentTurnRegistry.hasCostRecorded(turnId)) {
        for (const [model, s] of stats) {
          const cost = calculateCostOrWarn(
            model, s.inputTokens, s.outputTokens,
            turnLogger ?? logger, 'adhoc-proxy',
          );
          if (cost == null || cost <= 0) continue;
          appendCostEntry({
            ts: Date.now(),
            cost,
            sid: agentTurnRegistry.getRendererSession(turnId),
            tid: turnId,
            cat: 'adhoc-model',
            m: model,
            auth: agentTurnRegistry.getTurnAuthMethod(turnId),
            outcome: totalErrors > 0
              ? { kind: 'failed', reason: 'provider_error' }
              : { kind: 'success' },
          });
        }
      }

      // Surface ad-hoc model failures to the user
      if (totalErrors > 0 && meta) {
        const failedModels: string[] = [];
        for (const [model, s] of stats) {
          if (s.errorCount > 0) {
            const displayName = meta.modelDisplayNames.get(model) ?? model;
            failedModels.push(displayName);
          }
        }
        if (failedModels.length > 0) {
          const failedList = failedModels.join(', ');
          dispatchAgentEvent(meta.win, turnId, {
            type: 'status',
            message: `Ad-hoc model: ${failedList} had errors.`,
            timestamp: Date.now(),
          });
          const turnLogger = agentTurnRegistry.getTurnLogger(turnId);
          if (turnLogger) {
            turnLogger.warn({ failedModels, totalErrors }, 'Ad-hoc model failure surfaced to user');
          }
        }
      }
    }
  }
  // Mark this live attempt cleaned BEFORE running the cleanup body so a
  // re-entrant call for the same live attempt no-ops via the gate at the top
  // (rework-final-F3). `cleanupTurnAttempt` does NOT touch the registry, so this
  // flag is the single source of truth for "this attempt has been cleaned".
  if (entry) entry.cleaned = true;
  // Step 1: Per-attempt cleanup AFTER cost-ledger pre-read so proxy stats survive.
  cleanupTurnAttempt(turnId);

  // Step 2: Terminal-only cleanup. Keep finalize before registry deletion so
  // the turn logger is still readable, matching the pre-Stage-3 ordering.
  _completionReasonForFinalize = reason;
  try {
    for (const key of ALL_CLEANUP_KEYS) {
      const fn = TERMINAL_CLEANUP_FNS[key];
      if (fn === null) continue;
      try {
        fn(turnId);
      } catch (err) {
        logger.warn({ key, turnId, err }, 'completeTurnCleanup: per-key terminal cleanup threw — continuing');
      }
    }
  } finally {
    _completionReasonForFinalize = undefined;
  }
  // The turn's live attempt is fully cleaned. Drop the registry entry so the Map
  // stays O(1) per LIVE turn (no per-turn leak). This is safe against a stale
  // OLD-attempt continuation resuming LATER: an epoch-bearing call then finds no
  // entry and no-ops via the gate above. A legitimate RETRY re-registers via
  // beginTurnAttempt (which overwrites, so no delete is even reached on that
  // path — completeTurnCleanup is not called for the old attempt on retry).
  if (entry) liveTurnAttempts.delete(turnId);
};
