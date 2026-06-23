/**
 * Turn Observability — thin reliability-telemetry spine.
 *
 * Accumulates a few low-cardinality, PII-free signals per logical agent turn
 * and emits ONE structured terminal event (`Agent Turn Terminal Observed`) when
 * the turn ends. The purpose is production visibility into the
 * `transient_failure_retry_storm_or_hang` bug family (offline retry storms,
 * watchdog hangs) and the data needed to make retry-policy decisions
 * (e.g. whether a provider should set `maxRetries: 0`).
 *
 * Design (per `docs/plans/260619_offline-deferred-followups/PLAN.md` Stage C,
 * informed by the gpt-5.5-extra-high architecture review):
 * - **Dedicated core service**, not another map on the `agentTurnRegistry`
 *   god-object, and not renderer analytics (too late / surface-local). Owns its
 *   own per-turn state, so registry cleanup ordering is irrelevant.
 * - **Cross-surface** via the `@core/tracking` boundary (`getTracker()`).
 *   Desktop + cloud emit; mobile already excludes core turn events.
 * - **`startTurn`** is first-wins so fallback re-entry into `turnAdmission.admit`
 *   for the SAME logical turnId preserves `startedAt` and accumulated counts.
 * - **`completeTurn`** is idempotent: once it emits and drops the entry, a
 *   repeated call (tests / belt-and-braces cleanup) is a no-op. It is called
 *   from `completeTurnCleanup` BEFORE registry deletion.
 * - **Fail-open**: a throwing tracker must never break a turn. The emit is
 *   wrapped; failures are logged, not propagated (AGENTS.md "silent failure is
 *   a bug" — observable, not swallowed).
 *
 * THIN SLICE — explicitly out of scope (see the PLAN Appendix): fetch-layer
 * actual-HTTP-attempt counting (the SDK's opaque inner retries), `maxRetries:0`
 * everywhere, sub-agent/BTS amplification attribution, watchdog/cost dimension
 * folding, and unifying the existing scattered turn events. This slice counts
 * only our OWN `runWithRetry` retries — honest about what it observes.
 */

import { createScopedLogger } from '@core/logger';
import { getTracker } from '@core/tracking';
import type { PlatformSurface } from '@core/platform';
import { hashSessionId } from '@shared/trackingTypes';

// Lazy logger: created on first use (only in the rare fail-open catch), NOT at
// module load. This service is imported by admission, cleanup, retry telemetry,
// and both clients — a module-load `createScopedLogger()` call would break any
// of their tests that partially mock `@core/logger`.
let _log: ReturnType<typeof createScopedLogger> | undefined;
const getLog = (): ReturnType<typeof createScopedLogger> =>
  (_log ??= createScopedLogger({ service: 'turnObservability' }));

/** Analytics event name for the per-turn terminal reliability metric. */
export const TURN_TERMINAL_EVENT = 'Agent Turn Terminal Observed';
/** Schema version — bump when the event's dimension set changes. */
export const TURN_TERMINAL_SCHEMA_VERSION = 2;

/** Coarse terminal classification derived from the cleanup `reason` string. */
export type TerminalKind =
  | 'success'
  | 'aborted'
  | 'watchdog_aborted'
  | 'admission_blocked'
  // The pre-dispatch liveness guard fired (a turn wedged BEFORE reaching the
  // model — typically an unresponsive cloud-storage mount starving the libuv
  // pool). Split out from the generic `'error'` bucket so this previously
  // self-concealing failure mode is an alertable dimension of its own. See the
  // guard at agentTurnExecute.ts (`PRE_DISPATCH_SETUP_TIMEOUT_MS`).
  | 'pre_dispatch_setup_timeout'
  | 'error';

/** Reason strings produced by `turnAdmission.admit` terminal exits. */
const ADMISSION_BLOCKED_REASONS = new Set<string>([
  'missing-core-directory',
  'missing-auth',
  'codex-not-connected',
  'openrouter-not-connected',
  'mindstone-key-missing',
]);

const ABORT_REASONS = new Set<string>(['aborted', 'user_stopped', 'superseded']);

/**
 * Map a cleanup `reason` to a coarse, low-cardinality terminal kind. The raw
 * reason is preserved on the event as `cleanupReason` for debugging; this is
 * the dimension dashboards group by.
 */
export function classifyTerminalKind(reason: string): TerminalKind {
  if (reason.startsWith('completed')) return 'success';
  if (ABORT_REASONS.has(reason)) return 'aborted';
  // Exact-match the pre-dispatch liveness-guard reason BEFORE the generic
  // fallthrough (it's the literal passed to `completeTurnCleanup` when the guard
  // fires). It is not an abort/watchdog/admission reason, so ordering vs. those
  // is not load-bearing — placed here for readability.
  if (reason === 'pre_turn_setup_timeout') return 'pre_dispatch_setup_timeout';
  if (reason.includes('watchdog') || reason.includes('awaiting-api-stall')) return 'watchdog_aborted';
  if (ADMISSION_BLOCKED_REASONS.has(reason)) return 'admission_blocked';
  return 'error';
}

interface TurnObservation {
  startedAt: number;
  origin: 'manual' | 'automation';
  turnCategory: string;
  requestedProvider: string;
  rendererSessionId: string | null;
  surface: PlatformSurface;
  appRetryCount: number;
  offlineDetected: boolean;
}

/** Inputs captured at turn admission (the start seam). */
export interface StartTurnInput {
  startedAt: number;
  origin: 'manual' | 'automation';
  /**
   * Raw session kind (`classifySessionKind`) — the service maps it to the coarse
   * `turnCategory` here rather than at the admission seam, both to keep the
   * admission code free of the `'automation'` literal (eslint TurnPolicy fence)
   * and to avoid a registry read that partial test mocks don't stub.
   */
  sessionKind: string | null;
  requestedProvider: string;
  rendererSessionId: string | null;
  surface: PlatformSurface;
}

/** Map the granular session kind to the coarse cost/turn category dimension. */
function deriveTurnCategory(sessionKind: string | null): string {
  if (sessionKind === 'automation' || sessionKind === 'automation-insight') return 'automation';
  if (sessionKind === 'memory-update') return 'memory';
  return 'conversation';
}

/**
 * Terminal input. Only the cleanup `reason` is carried.
 *
 * Deliberately NO registry enrichment (resolved provider / auth / model): the
 * terminal seam (`completeTurnCleanup`) is hot and widely test-mocked, and
 * unconditional registry reads there both couple it to registry internals and
 * risk PII (the turn model can be a user-configured profile string — F1). The
 * provider dimension is captured at `startTurn` (`requestedProvider`); the
 * post-fallback resolved provider, auth method, and a sanitized model dim are
 * deferred to a later stage that records them at the route-resolution seam.
 * See the PLAN Appendix.
 */
export interface CompleteTurnInput {
  reason: string;
}

class TurnObservabilityService {
  private readonly turns = new Map<string, TurnObservation>();

  /**
   * Begin observing a logical turn. First-wins: if the turn is already being
   * observed (fallback re-entry into admission with the same turnId), this is a
   * no-op so `startedAt` and accumulated counts survive across attempts.
   */
  startTurn(turnId: string, input: StartTurnInput): void {
    if (!turnId || this.turns.has(turnId)) return;
    this.turns.set(turnId, {
      startedAt: input.startedAt,
      origin: input.origin,
      turnCategory: deriveTurnCategory(input.sessionKind),
      requestedProvider: input.requestedProvider,
      rendererSessionId: input.rendererSessionId,
      surface: input.surface,
      appRetryCount: 0,
      offlineDetected: false,
    });
  }

  /**
   * Record one app-level (`runWithRetry`) retry attempt. Attribution is by the
   * current turn context; a no-op when there is no turnId or no active
   * observation for it (e.g. sub-agent calls outside the main turn — deferred).
   */
  recordAppRetry(turnId: string | undefined): void {
    if (!turnId) return;
    const obs = this.turns.get(turnId);
    if (obs) obs.appRetryCount += 1;
  }

  /** Mark that the offline reachability probe confirmed offline during this turn. */
  recordOfflineDetected(turnId: string | undefined): void {
    if (!turnId) return;
    const obs = this.turns.get(turnId);
    if (obs) obs.offlineDetected = true;
  }

  /**
   * Emit the terminal reliability event and drop the turn's state. Idempotent:
   * a repeated call after the entry is gone is a no-op (handles the terminal
   * seam being invoked more than once). Fail-open: a throwing tracker is logged,
   * never propagated.
   */
  completeTurn(turnId: string, input: CompleteTurnInput): void {
    const obs = this.turns.get(turnId);
    if (!obs) return;
    // Drop FIRST so any throw below still guarantees once-only semantics.
    this.turns.delete(turnId);

    try {
      const durationMs = Math.max(0, Date.now() - obs.startedAt);
      const sessionIdHash = obs.rendererSessionId ? hashSessionId(obs.rendererSessionId) : undefined;
      getTracker().track(TURN_TERMINAL_EVENT, {
        schemaVersion: TURN_TERMINAL_SCHEMA_VERSION,
        turnId,
        ...(sessionIdHash ? { sessionIdHash } : {}),
        surface: obs.surface,
        origin: obs.origin,
        turnCategory: obs.turnCategory,
        requestedProvider: obs.requestedProvider,
        terminalKind: classifyTerminalKind(input.reason),
        cleanupReason: input.reason,
        durationMs,
        appRetryCount: obs.appRetryCount,
        offlineDetected: obs.offlineDetected,
      });
    } catch (err) {
      // Fail-open: telemetry must never break a turn. Observable, not swallowed.
      getLog().warn({ turnId, err }, 'turnObservability.completeTurn emit failed — continuing');
    }
  }

  /** Test-only: current number of in-flight observations. */
  __activeCountForTest(): number {
    return this.turns.size;
  }

  /** Test-only: reset all state between tests. */
  __resetForTest(): void {
    this.turns.clear();
  }
}

/** Singleton — one observability spine per process. */
export const turnObservability = new TurnObservabilityService();
