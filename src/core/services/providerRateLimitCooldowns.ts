/**
 * Provider rate-limit cooldown store (Stage 4 — multi-provider failover).
 *
 * Tracks which CREDENTIAL SOURCES are currently in a rate-limit cooldown so the
 * route-decision selection seam can skip them and fail over to the next usable
 * provider in the user's `enabledProviders` list (same logical model, different
 * provider). Companion to {@link ApiRateLimitCooldown} (the global "don't all
 * retry into the same rate-limited endpoint" guard) — this one is finer-grained:
 * keyed per credential source so failover is precise.
 *
 * WHY keyed by `ProviderCredentialSource`, not by provider (PLAN Stage 4
 * "cooldown key" decision): two enabled providers can resolve to the SAME route
 * provider with DIFFERENT credentials (e.g. `mindstone` → `openrouter` w/
 * `mindstone-managed-key` vs a personal `openrouter` → `openrouter-oauth-token`).
 * A 429 on the managed key must NOT cool down the user's own OpenRouter key.
 * Keying by the exhausted credential avoids that over-block. (Trade-off: it can
 * under-block account-wide throttling that spans credentials — acceptable v1;
 * the global ApiRateLimitCooldown still backstops a retry storm.)
 *
 * IN-MEMORY ONLY (v1): cooldowns are lost on restart. That is intentional and
 * acceptable — a stale cooldown after restart would only delay re-trying a
 * provider that is probably fine again; the live 429 path re-arms it if not.
 *
 * Consumed by routing via a PURE seam: the route decision reads a SNAPSHOT of
 * the cooled-down set ({@link ProviderRateLimitCooldownStore.cooledDownSources})
 * and threads it as an input (like `codexConnectivity`), so `routeDecision` and
 * `isUsableProviderMode` stay pure/deterministic. The store is NOT read inside
 * the router itself.
 */
import { createScopedLogger } from '@core/logger';
import type { ProviderCredentialSource } from '@shared/types/providerRoute';

const log = createScopedLogger({ service: 'providerRateLimitCooldowns' });

const DEFAULT_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 5 * 60_000;

export class ProviderRateLimitCooldownStore {
  /** credentialSource → epoch ms until which it is cooled down. */
  private readonly cooldownUntil = new Map<ProviderCredentialSource, number>();

  /**
   * Record a rate-limit hit for a credential source. Sets/extends the cooldown.
   * Never SHORTENS an existing cooldown (matches ApiRateLimitCooldown semantics).
   */
  recordRateLimit(source: ProviderCredentialSource, retryAfterMs?: number, now: number = Date.now()): void {
    const cooldownMs = retryAfterMs ? Math.min(retryAfterMs, MAX_COOLDOWN_MS) : DEFAULT_COOLDOWN_MS;
    const until = now + cooldownMs;
    const existing = this.cooldownUntil.get(source) ?? 0;
    if (until > existing) {
      this.cooldownUntil.set(source, until);
      log.warn(
        { credentialSource: source, cooldownMs, cooldownUntil: new Date(until).toISOString() },
        'provider rate-limit cooldown activated',
      );
    }
  }

  /** Whether the given credential source is currently cooled down. */
  isInCooldown(source: ProviderCredentialSource, now: number = Date.now()): boolean {
    const until = this.cooldownUntil.get(source);
    return until !== undefined && now < until;
  }

  /** Milliseconds remaining on a source's cooldown (0 if none/expired). */
  remainingMs(source: ProviderCredentialSource, now: number = Date.now()): number {
    const until = this.cooldownUntil.get(source);
    return until === undefined ? 0 : Math.max(0, until - now);
  }

  /** Clear a source's cooldown — call after a successful dispatch on it. */
  recordSuccess(source: ProviderCredentialSource): void {
    this.cooldownUntil.delete(source);
  }

  /**
   * Snapshot of the credential sources currently in cooldown. This is what the
   * route caller threads into the router input. Pruned of expired entries so the
   * set is exactly "cooled down right now".
   */
  cooledDownSources(now: number = Date.now()): ReadonlySet<ProviderCredentialSource> {
    const active = new Set<ProviderCredentialSource>();
    for (const [source, until] of this.cooldownUntil) {
      if (now < until) {
        active.add(source);
      } else {
        this.cooldownUntil.delete(source);
      }
    }
    return active;
  }

  /** Test/reset hook — drop all cooldowns. */
  clearAll(): void {
    this.cooldownUntil.clear();
  }
}

/** Process-wide singleton (mirrors the `apiRateLimitCooldown` export pattern). */
export const providerRateLimitCooldowns = new ProviderRateLimitCooldownStore();
