/**
 * Pending checkout tier expectation.
 *
 * Tracks the tier the user requested in their most recent
 * `subscription:create-checkout` invocation so the post-checkout deep-link
 * retry loop can wait for the Stripe webhook to actually flip the tier
 * before declaring success.
 *
 * Without this, an upgrade flow (e.g. Dash -> Rogue) short-circuits on the
 * pre-existing active Dash subscription. See
 * `docs-private/investigations/260520_pro_to_expert_upgrade_not_reflected.md`.
 *
 * Per-process, in-memory only. Cleared on success / cancel / TTL expiry.
 * Persistence to electron-store across an app restart is a follow-up.
 */

import { createScopedLogger } from '@core/logger';
import type { SubscriptionTier } from '@shared/types';

const log = createScopedLogger({ service: 'pending-checkout-tier' });

const DEFAULT_TTL_MS = 10 * 60 * 1000;

interface PendingEntry {
  tier: SubscriptionTier;
  expiresAt: number;
}

const bySessionId = new Map<string, PendingEntry>();
let latest: PendingEntry | null = null;

function isExpired(entry: PendingEntry, now: number): boolean {
  return entry.expiresAt <= now;
}

function evictExpired(now: number): void {
  if (latest && isExpired(latest, now)) latest = null;
  for (const [sessionId, entry] of bySessionId) {
    if (isExpired(entry, now)) bySessionId.delete(sessionId);
  }
}

export interface RecordPendingCheckoutOptions {
  tier: SubscriptionTier;
  sessionId?: string | null;
  ttlMs?: number;
}

export function recordPendingCheckout(options: RecordPendingCheckoutOptions): void {
  const now = Date.now();
  evictExpired(now);
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const entry: PendingEntry = { tier: options.tier, expiresAt: now + ttl };
  if (options.sessionId) {
    bySessionId.set(options.sessionId, entry);
  }
  latest = entry;
  log.debug(
    { tier: options.tier, hasSessionId: !!options.sessionId, ttlMs: ttl },
    'Recorded pending checkout tier expectation',
  );
}

/**
 * Look up + clear the expected tier for a callback. Prefers a session-id
 * match when provided, falls back to the latest single-slot expectation.
 * Returns `null` when no (un-expired) expectation is present.
 */
export function getPendingCheckout(sessionId?: string | null): SubscriptionTier | null {
  const now = Date.now();
  evictExpired(now);

  if (sessionId) {
    const entry = bySessionId.get(sessionId);
    if (entry && !isExpired(entry, now)) {
      bySessionId.delete(sessionId);
      if (latest && latest === entry) latest = null;
      return entry.tier;
    }
  }

  if (latest && !isExpired(latest, now)) {
    const tier = latest.tier;
    latest = null;
    return tier;
  }

  return null;
}

export function clearPendingCheckout(sessionId?: string | null): void {
  if (sessionId) {
    const entry = bySessionId.get(sessionId);
    bySessionId.delete(sessionId);
    if (latest && latest === entry) latest = null;
    return;
  }
  latest = null;
}

export function __resetPendingCheckoutTierForTests(): void {
  bySessionId.clear();
  latest = null;
}

const STRIPE_SESSION_ID_REGEX = /\b(cs_(?:test|live)_[A-Za-z0-9]+)\b/;

export function parseStripeSessionId(url: string): string | null {
  const match = STRIPE_SESSION_ID_REGEX.exec(url);
  return match ? match[1] : null;
}
