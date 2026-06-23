/**
 * Cooldown Status Broadcast — thin wrapper around BroadcastService for the
 * cooldown:status-changed channel.
 *
 * Purpose: bridge cooldown enter/exit transitions from the cooldown singleton
 * (in core) to renderer hooks (in App.tsx via useApiCooldownEvents). The event
 * is GLOBAL state (app-wide cooldown), not per-session — there is no
 * `originalSessionId` field by design.
 *
 * On cloud / non-desktop surfaces, BroadcastService is a no-op implementation;
 * this wrapper silently no-ops in that case.
 *
 * Channel: cooldown:status-changed
 * Payload: CooldownStatusChangedPayload
 */
import { getBroadcastService } from '@core/broadcastService';
import { createScopedLogger } from '@core/logger';
import type { CooldownScope } from './diagnostics/manifest';

const log = createScopedLogger({ service: 'cooldownStatusBroadcast' });

export const COOLDOWN_STATUS_CHANNEL = 'cooldown:status-changed' as const;

/**
 * Why the cooldown was entered. Populated only on the `safety-eval-degraded`
 * scope when the caller can derive it from the upstream error; absent for api-
 * and safety-eval-scoped cooldowns (and for degradation cooldowns entered
 * without structured error context).
 *
 * - `billing`          — usage cap / quota exhaustion (e.g. ChatGPT Team plan).
 * - `rate_limit`       — standard transient 429 rate limit.
 * - `auth`             — authentication / API key failure.
 * - `model_unavailable`— model not accessible at the provider.
 * - `other`            — any other failure kind.
 */
export type ReasonKind = 'billing' | 'rate_limit' | 'auth' | 'model_unavailable' | 'other';

export interface CooldownStatusChangedPayload {
  scope: CooldownScope;
  state: 'entered' | 'exited';
  untilMs?: number;
  durationMs?: number;
  /**
   * Cause of the cooldown (safety-eval-degraded scope only).
   * Absent for api / safety-eval scopes.
   */
  reasonKind?: ReasonKind;
  /**
   * Absolute epoch-ms when the upstream limit resets, if the provider returned
   * one (safety-eval-degraded / billing case). Not guaranteed even for billing.
   */
  resetAtMs?: number;
}

export function broadcastCooldownStatus(payload: CooldownStatusChangedPayload): void {
  try {
    const broadcaster = getBroadcastService();
    broadcaster.sendToAllWindows(COOLDOWN_STATUS_CHANNEL, payload);
    log.debug({ payload }, 'cooldown status broadcast');
  } catch (error) {
    // Broadcaster not initialized (early startup) or send failure.
    // The poll-based health check will pick up the cooldown at the next poll.
    log.warn({ err: error, payload }, 'cooldown status broadcast skipped');
  }
}
