/**
 * API Rate-Limit Cooldown
 *
 * Shared cooldown that prevents concurrent turns from all retrying into the
 * same rate-limited provider simultaneously. When one turn hits a rate limit,
 * the cooldown is activated and subsequent turns check it before starting a
 * new API call. This avoids the "retry storm" where N turns independently
 * hammer a rate-limited endpoint and exhaust the budget together.
 *
 * Design follows the same pattern as CloudFailureCooldown:
 * - After a rate limit hit, all new turns are blocked for a cooldown period
 * - The cooldown respects Retry-After when available, otherwise uses a default
 * - Any successful API call resets the cooldown
 */

import { createScopedLogger } from '@core/logger';
import type { CooldownScope } from './diagnostics/manifest';
import { appendDiagnosticEvent } from './diagnosticEventsLedger';
import { broadcastCooldownStatus } from './cooldownStatusBroadcast';
import type { ReasonKind } from './cooldownStatusBroadcast';
import {
  getPersistedCooldown,
  persistCooldown,
  clearPersistedCooldown,
} from './cooldownStore';

const log = createScopedLogger({ service: 'apiRateLimitCooldown' });

const DEFAULT_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 5 * 60_000;
export const SAFETY_EVAL_DEGRADATION_FLOOR_MS = 30_000;

export interface ApiRateLimitCooldownOptions {
  /** When true, cooldown state is persisted to disk and restored on startup. */
  persistState?: boolean;
  /**
   * Diagnostic-events scope used when emitting cooldown_enter/exit transitions.
   * Defaults to 'api' for the canonical persisted instance and 'safety-eval'
   * for the in-memory safety evaluation singleton — but pass it explicitly to
   * avoid coupling diagnostic identity to storage behaviour when adding new
   * instances.
   */
  scope?: CooldownScope;
}

export class ApiRateLimitCooldown {
  private cooldownUntil = 0;
  private generationId = 0;
  private readonly persistState: boolean;
  private readonly scope: CooldownScope;
  private restoredFromDisk = false;

  constructor(options?: ApiRateLimitCooldownOptions) {
    this.persistState = options?.persistState ?? false;
    this.scope = options?.scope ?? (this.persistState ? 'api' : 'safety-eval');
  }

  /** Lazy one-time restore of persisted cooldown on first query. */
  private ensureRestoredFromDisk(): void {
    if (this.restoredFromDisk || !this.persistState) return;
    this.restoredFromDisk = true;
    try {
      const persisted = getPersistedCooldown();
      if (persisted > this.cooldownUntil) {
        this.cooldownUntil = persisted;
        log.info(
          { cooldownUntil: new Date(persisted).toISOString() },
          'Restored rate-limit cooldown from disk',
        );
      }
    } catch (error) {
      log.warn({ err: error }, 'Failed to restore persisted cooldown');
    }
  }

  /**
   * Check whether a new API call should proceed.
   * Returns true if no cooldown is active (or it has expired).
   */
  isAvailable(): boolean {
    this.ensureRestoredFromDisk();
    return this.computeIsAvailable();
  }

  /** Internal availability check that does not trigger lazy disk restore. */
  private computeIsAvailable(): boolean {
    return Date.now() >= this.cooldownUntil;
  }

  /**
   * Returns the number of milliseconds remaining until the cooldown expires.
   * Returns 0 if no cooldown is active.
   */
  remainingMs(): number {
    this.ensureRestoredFromDisk();
    return Math.max(0, this.cooldownUntil - Date.now());
  }

  /**
   * Record a rate-limit hit. Sets the cooldown to block subsequent calls.
   *
   * @param retryAfterMs  Parsed Retry-After value in ms, if the API provided one.
   * @param context       Optional failure context (safety-eval-degraded scope only).
   *                      Callers on the `api` and `safety-eval` scopes must NOT
   *                      pass this — it is ONLY populated by the safety-eval
   *                      degradation path so the renderer can render cause-aware copy.
   */
  recordRateLimit(retryAfterMs?: number, context?: { reasonKind?: ReasonKind; resetAtMs?: number }): void {
    this.ensureRestoredFromDisk();
    const cooldownMs = retryAfterMs
      ? Math.min(retryAfterMs, MAX_COOLDOWN_MS)
      : DEFAULT_COOLDOWN_MS;
    const until = Date.now() + cooldownMs;

    // Only extend -- never shorten an existing cooldown
    if (until > this.cooldownUntil) {
      const wasActive = !this.computeIsAvailable();
      if (!wasActive) {
        this.generationId++;
      }
      this.cooldownUntil = until;
      log.warn({ cooldownMs, cooldownUntil: new Date(this.cooldownUntil).toISOString() },
        'API rate-limit cooldown activated');
      if (this.persistState) {
        persistCooldown(this.cooldownUntil);
      }
      if (!wasActive) {
        // inactive → active transition: emit a single diagnostic enter event.
        // Re-entries that merely extend an existing cooldown are intentionally
        // NOT re-emitted to keep the ledger free of bursty noise.
        appendDiagnosticEvent({
          kind: 'cooldown_enter',
          data: {
            scope: this.scope,
            untilMs: this.cooldownUntil,
            retryAfterProvided: retryAfterMs !== undefined,
            durationMs: cooldownMs,
            ...(context?.reasonKind ? { reasonKind: context.reasonKind } : {}),
            ...(context?.resetAtMs ? { resetAtMs: context.resetAtMs } : {}),
          },
        });
        broadcastCooldownStatus({
          scope: this.scope,
          state: 'entered',
          untilMs: this.cooldownUntil,
          durationMs: cooldownMs,
          ...(context?.reasonKind ? { reasonKind: context.reasonKind } : {}),
          ...(context?.resetAtMs ? { resetAtMs: context.resetAtMs } : {}),
        });
      }
    }
  }

  /**
   * Record a successful API call. Clears the cooldown so queued turns can proceed.
   */
  recordSuccess(): void {
    this.ensureRestoredFromDisk();
    const wasActive = !this.computeIsAvailable();
    if (this.cooldownUntil > 0) {
      log.info('API rate-limit cooldown cleared (successful call)');
      if (this.persistState) {
        clearPersistedCooldown();
      }
    }
    this.cooldownUntil = 0;
    if (wasActive) {
      // active → inactive transition.
      appendDiagnosticEvent({
        kind: 'cooldown_exit',
        data: {
          scope: this.scope,
          reason: 'success',
        },
      });
      broadcastCooldownStatus({ scope: this.scope, state: 'exited' });
    }
  }

  reset(): void {
    const wasActive = !this.computeIsAvailable();
    this.restoredFromDisk = true; // skip restore — we're clearing everything
    this.cooldownUntil = 0;
    if (this.persistState) {
      clearPersistedCooldown();
    }
    if (wasActive) {
      appendDiagnosticEvent({
        kind: 'cooldown_exit',
        data: {
          scope: this.scope,
          reason: 'reset',
        },
      });
      broadcastCooldownStatus({ scope: this.scope, state: 'exited' });
    }
  }

  currentGenerationId(): number {
    return this.generationId;
  }

  /** Expose state for testing. */
  _getState(): { cooldownUntil: number; generationId: number } {
    return { cooldownUntil: this.cooldownUntil, generationId: this.generationId };
  }
}

export const apiRateLimitCooldown = new ApiRateLimitCooldown({ persistState: true, scope: 'api' });

/**
 * Separate cooldown for safety evaluations (tool safety, memory safety).
 *
 * Safety evals typically use Haiku via the BTS client, which is a different
 * model/tier from the agent's Sonnet calls. A 429 on Sonnet should NOT block
 * Haiku safety evals, and vice versa. This instance isolates safety eval
 * rate-limit state from the agent turn cooldown.
 */
export const safetyEvalRateLimitCooldown = new ApiRateLimitCooldown({ scope: 'safety-eval' });

/**
 * Observability-only cooldown for sustained safety-eval degradation.
 *
 * Unlike safetyEvalRateLimitCooldown, this scope is never read as a gate in
 * evaluation control flow; it only drives diagnostics + renderer nudges.
 */
export const safetyEvalDegradationCooldown = new ApiRateLimitCooldown({
  scope: 'safety-eval-degraded',
});
