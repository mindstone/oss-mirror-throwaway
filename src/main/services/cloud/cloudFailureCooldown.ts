/**
 * Cloud Failure Cooldown (Escalating Circuit Breaker)
 *
 * Tracks consecutive cloud call failures and fast-fails when the cloud is
 * down. Uses escalating cooldown periods to prevent request storms during
 * prolonged outages while still recovering quickly from transient issues.
 *
 * Escalation:
 *   3 failures  → 30s cooldown  (transient — network blip, machine waking)
 *   6 failures  → 2min cooldown (sustained — machine slow to boot)
 *   10 failures → 5min cooldown  (prolonged — machine stuck or crashed)
 *   15 failures → 15min cooldown (extended — needs recovery intervention)
 *
 * After each cooldown expires, one probe is allowed through (natural
 * "half-open" state). If it succeeds, everything resets. If it fails,
 * cooldown restarts at the current escalation level.
 *
 * `degradedSince` tracks the timestamp of the first failure in the current
 * degraded period. Callers can use this to determine how long cloud has
 * been unreachable and trigger recovery actions (e.g., machine restart).
 */

import { createScopedLogger } from '@core/logger';
import { getBroadcastService } from '@core/broadcastService';
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
import type { CloudErrorCategory } from '@core/services/cloud/cloudErrorCategory';
import type { ReconcilerWriter } from '@core/services/cloud/cloudConnectionReconcilerTypes';

const log = createScopedLogger({ service: 'cloudFailureCooldown' });

const ESCALATION_LEVELS: Array<{ threshold: number; cooldownMs: number }> = [
  { threshold: 3,  cooldownMs: 30_000 },    // 30s
  { threshold: 6,  cooldownMs: 120_000 },   // 2min
  { threshold: 10, cooldownMs: 300_000 },   // 5min
  { threshold: 15, cooldownMs: 900_000 },   // 15min (max)
];

export interface CircuitState {
  available: boolean;
  consecutiveFailures: number;
  cooldownMs: number;
  degradedSince: number | null;
}

export interface CloudFailureRecordFailureContext {
  writer?: ReconcilerWriter;
  category?: CloudErrorCategory;
}

export interface CloudFailureRecordSuccessContext {
  writer?: ReconcilerWriter;
  lastCategory?: CloudErrorCategory;
}

export interface CloudSyncOutcome {
  /** Number of cloud-side operations that completed successfully. */
  ok: number;
  /** Number of operations that failed after the feeder handled/continued. */
  failed: number;
  /** Subset of failed operations whose error indicates auth failure. */
  authFailures: number;
  /** Sample error captured by the feeder for logging/diagnostics. */
  sampleError?: unknown;
  /**
   * True when the sync was abandoned because the connection changed mid-flight
   * (disconnect / account switch). Such an outcome is neither success nor
   * failure — `recordCooldownVerdict()` ignores it so a superseded pull never
   * resets the failure streak or escalates cooldown.
   */
  superseded?: boolean;
}

export interface CloudFailureCooldownVerdictContext {
  writer?: ReconcilerWriter;
  category?: CloudErrorCategory;
  lastCategory?: CloudErrorCategory;
}

export interface CloudFailureCooldownTransitionContext {
  writer?: ReconcilerWriter;
  category?: CloudErrorCategory;
  escalationLevel: number;
  consecutiveFailures: number;
}

export interface CloudFailureCooldownRecoveryContext {
  downtimeMs: number;
  ticksToRecovery: number;
  lastCategory?: CloudErrorCategory;
  lastWriter?: ReconcilerWriter;
}

export interface CloudFailureCooldownObservabilityHooks {
  onDegradedEnter?: (context: CloudFailureCooldownTransitionContext) => void;
  onDegradedEscalated?: (context: CloudFailureCooldownTransitionContext) => void;
  onDegradedExit?: (context: CloudFailureCooldownRecoveryContext) => void;
}

function getCooldownForFailureCount(failures: number): number {
  let cooldown = 0;
  for (const level of ESCALATION_LEVELS) {
    if (failures >= level.threshold) {
      cooldown = level.cooldownMs;
    }
  }
  return cooldown;
}

function getActiveEscalationLevel(failures: number): number | null {
  if (failures >= 15) return 3;
  if (failures >= 10) return 2;
  if (failures >= 6) return 1;
  if (failures >= 3) return 0;
  return null;
}

export class CloudFailureCooldown {
  private consecutiveFailures = 0;
  private lastFailureAt = 0;
  private degradedSince: number | null = null;
  private currentCooldownMs = 0;
  private recoveryTriggered = false;
  private lastCategory: CloudErrorCategory | undefined;
  private lastWriter: ReconcilerWriter | undefined;
  private observabilityHooks: CloudFailureCooldownObservabilityHooks = {};

  isAvailable(): boolean {
    if (this.consecutiveFailures < ESCALATION_LEVELS[0].threshold) return true;
    if (Date.now() - this.lastFailureAt >= this.currentCooldownMs) return true;
    return false;
  }

  setObservabilityHooks(hooks: CloudFailureCooldownObservabilityHooks): void {
    this.observabilityHooks = hooks;
  }

  recordCooldownVerdict(outcome: CloudSyncOutcome, context: CloudFailureCooldownVerdictContext = {}): void {
    // A superseded sync (connection changed mid-flight) is neither success nor
    // failure — recording either would corrupt the streak. Ignore it.
    if (outcome.superseded) {
      return;
    }
    if (outcome.failed === 0 && outcome.authFailures === 0) {
      const successContext: CloudFailureRecordSuccessContext = {};
      if (context.writer !== undefined) successContext.writer = context.writer;
      if (context.lastCategory !== undefined) successContext.lastCategory = context.lastCategory;
      this.recordSuccess(successContext);
      return;
    }

    const failureContext: CloudFailureRecordFailureContext = {};
    if (context.writer !== undefined) failureContext.writer = context.writer;
    if (context.category !== undefined) failureContext.category = context.category;
    this.recordFailure(failureContext);
  }

  /**
   * @deprecated Feeders should call recordCooldownVerdict() with an explicit
   * CloudSyncOutcome. Kept public for the connection reconciler probe adapter,
   * which records atomic success/failure probes rather than batch sync verdicts.
   */
  recordFailure(context: CloudFailureRecordFailureContext = {}): void {
    const now = Date.now();
    const wasDegraded = this.degradedSince !== null;
    const wasInCooldown = !this.isAvailable();
    const previousEscalationLevel = getActiveEscalationLevel(this.consecutiveFailures);

    this.consecutiveFailures++;
    this.lastFailureAt = now;

    if (this.degradedSince === null) {
      this.degradedSince = now;
    }
    if (context.category) this.lastCategory = context.category;
    if (context.writer) this.lastWriter = context.writer;

    const prevCooldown = this.currentCooldownMs;
    this.currentCooldownMs = getCooldownForFailureCount(this.consecutiveFailures);
    const activeEscalationLevel = getActiveEscalationLevel(this.consecutiveFailures);
    const escalationLevel = activeEscalationLevel ?? 0;

    if (!wasDegraded) {
      this.notifyObservabilityHook('cloud_connection_degraded', this.observabilityHooks.onDegradedEnter, {
        category: context.category,
        writer: context.writer,
        escalationLevel,
        consecutiveFailures: this.consecutiveFailures,
      });
    } else if (activeEscalationLevel !== null && activeEscalationLevel !== previousEscalationLevel) {
      this.notifyObservabilityHook('cloud_connection_degraded_escalated', this.observabilityHooks.onDegradedEscalated, {
        category: context.category ?? this.lastCategory,
        writer: context.writer ?? this.lastWriter,
        escalationLevel,
        consecutiveFailures: this.consecutiveFailures,
      });
    }

    if (this.currentCooldownMs > 0 && (prevCooldown === 0 || this.currentCooldownMs > prevCooldown)) {
      log.warn(
        { consecutiveFailures: this.consecutiveFailures, cooldownMs: this.currentCooldownMs, degradedSince: this.degradedSince },
        `Cloud circuit breaker escalated to ${this.currentCooldownMs / 1000}s cooldown`,
      );
    }

    // A1: emit cooldown_enter on inactive→active cooldown transition only.
    // Re-entries that merely extend an existing cooldown are intentionally
    // NOT re-emitted to keep the ledger free of bursty noise.
    const isInCooldown = !this.isAvailable();
    if (!wasInCooldown && isInCooldown) {
      appendDiagnosticEvent({
        kind: 'cooldown_enter',
        data: {
          scope: 'cloud',
          untilMs: this.lastFailureAt + this.currentCooldownMs,
          retryAfterProvided: false,
          durationMs: this.currentCooldownMs,
        },
      });
    }

    this.broadcastState();
  }

  /**
   * @deprecated Feeders should call recordCooldownVerdict() with an explicit
   * CloudSyncOutcome. Kept public for the connection reconciler probe adapter,
   * which records atomic success/failure probes rather than batch sync verdicts.
   */
  recordSuccess(context: CloudFailureRecordSuccessContext = {}): void {
    const wasDegraded = this.degradedSince !== null;
    const wasInCooldown = !this.isAvailable();
    const priorDegradedSince = this.degradedSince;
    const ticksToRecovery = this.consecutiveFailures;
    const lastCategory = context.lastCategory ?? this.lastCategory;
    const lastWriter = context.writer ?? this.lastWriter;

    if (wasDegraded) {
      const degradedDuration = this.degradedSince ? Date.now() - this.degradedSince : 0;
      log.info({ degradedDurationMs: degradedDuration }, 'Cloud circuit breaker closed (cloud recovered)');
      this.notifyObservabilityHook('cloud_connection_recovered', this.observabilityHooks.onDegradedExit, {
        downtimeMs: priorDegradedSince ? Date.now() - priorDegradedSince : 0,
        ticksToRecovery,
        lastCategory,
        lastWriter,
      });
    }
    this.consecutiveFailures = 0;
    this.lastFailureAt = 0;
    this.degradedSince = null;
    this.currentCooldownMs = 0;
    this.recoveryTriggered = false;
    this.lastCategory = undefined;
    this.lastWriter = undefined;

    // A1: emit cooldown_exit only on active→inactive cooldown transition.
    if (wasInCooldown) {
      appendDiagnosticEvent({
        kind: 'cooldown_exit',
        data: { scope: 'cloud', reason: 'success' },
      });
    }

    if (wasDegraded) {
      this.broadcastState();
    }
  }

  reset(): void {
    const wasDegraded = this.degradedSince !== null;
    const wasInCooldown = !this.isAvailable();
    this.consecutiveFailures = 0;
    this.lastFailureAt = 0;
    this.degradedSince = null;
    this.currentCooldownMs = 0;
    this.recoveryTriggered = false;
    this.lastCategory = undefined;
    this.lastWriter = undefined;
    if (wasInCooldown) {
      appendDiagnosticEvent({
        kind: 'cooldown_exit',
        data: { scope: 'cloud', reason: 'reset' },
      });
    }
    if (wasDegraded) {
      this.broadcastState();
    }
  }

  getState(): CircuitState {
    return {
      available: this.isAvailable(),
      consecutiveFailures: this.consecutiveFailures,
      cooldownMs: this.currentCooldownMs,
      degradedSince: this.degradedSince,
    };
  }

  getDegradedSince(): number | null {
    return this.degradedSince;
  }

  /**
   * Check if auto-recovery should be triggered. Returns true at most once
   * per degraded period when degradedSince exceeds the given threshold.
   */
  shouldTriggerRecovery(thresholdMs: number): boolean {
    if (this.recoveryTriggered) return false;
    if (this.degradedSince === null) return false;
    if (Date.now() - this.degradedSince < thresholdMs) return false;
    this.recoveryTriggered = true;
    return true;
  }

  /** Reset recovery trigger (e.g., after disconnect/reconnect cycle). */
  resetRecoveryTrigger(): void {
    this.recoveryTriggered = false;
  }

  /** Expose internal state for testing. */
  _getState(): {
    consecutiveFailures: number;
    lastFailureAt: number;
    degradedSince: number | null;
    currentCooldownMs: number;
    recoveryTriggered: boolean;
    lastCategory: CloudErrorCategory | undefined;
    lastWriter: ReconcilerWriter | undefined;
  } {
    return {
      consecutiveFailures: this.consecutiveFailures,
      lastFailureAt: this.lastFailureAt,
      degradedSince: this.degradedSince,
      currentCooldownMs: this.currentCooldownMs,
      recoveryTriggered: this.recoveryTriggered,
      lastCategory: this.lastCategory,
      lastWriter: this.lastWriter,
    };
  }

  private notifyObservabilityHook<TContext>(
    eventName: string,
    hook: ((context: TContext) => void) | undefined,
    context: TContext,
  ): void {
    if (!hook) return;
    try {
      hook(context);
    } catch (err) {
      log.warn({ err, eventName }, 'Cloud circuit breaker observability hook failed');
    }
  }

  private broadcastState(): void {
    try {
      getBroadcastService().sendToAllWindows('cloud:circuit-state', this.getState());
    } catch { /* renderer may not be ready */ }
  }
}

export const cloudFailureCooldown = new CloudFailureCooldown();
