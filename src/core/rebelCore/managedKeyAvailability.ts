/**
 * Single source of truth for "is a managed (Mindstone subscription) OpenRouter key
 * available?", exposed to the provider router as a registered cross-context resolver.
 *
 * Why this is a leaf module (no rebelCore/services imports): the router
 * (`providerRouting.selectProviderMode`) needs to resolve managed-key availability
 * when a caller forwards bare settings without injecting `hasManagedKey`. The resolver
 * used to live in `core/services/behindTheScenesClient.ts`, but that file imports
 * `ProviderRouter` from `providerRouting`, so importing it back into `providerRouting`
 * would create a circular import. Keeping the 3-line registry here — depending on
 * nothing — lets `providerRouting` consume it cycle-free.
 *
 * DI seam: each runtime registers its own provider at bootstrap —
 *   - desktop main:  `() => hasManagedOpenRouterKey()` (live secure-store read)
 *   - cloud / CLI:   `() => false`
 *
 * F4 (260609 — mirrors the BTS proxy-seam fix): `unwired` (a surface forgot to
 * call `registerManagedKeyAvailability` at bootstrap → managed-key routing
 * silently off) used to be INDISTINGUISHABLE from `registered-but-false` (a
 * legitimate "no managed key" state). The default read stays `false` so an
 * unresolved window never routes *worse* than before AND the single boolean
 * consumer (`providerRouting.selectProviderMode`) is untouched — but a read on
 * the `unwired` state now emits an `error`-level log with the greppable marker
 * `managed-key-availability-unwired`, so a forgotten bootstrap is LOUD and
 * attributable in CI/eval logs instead of silently conflating with "no key".
 * The `unwired` log fires once per read (the only reader is the router's
 * per-dispatch fallback); that's acceptable and intentionally noisy.
 */
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'managedKeyAvailability' });

let _managedKeyAvailabilityProvider: (() => boolean) | null = null;

export function registerManagedKeyAvailability(provider: () => boolean): void {
  _managedKeyAvailabilityProvider = provider;
}

/** @internal test-only — return to the unwired (never-registered) state. */
export function __resetManagedKeyAvailabilityForTesting(): void {
  _managedKeyAvailabilityProvider = null;
}

/**
 * FAIL-SOFT BY DESIGN: unwired ⇒ `false`, NOT a throw — the router's per-dispatch
 * fallback must never crash a non-managed surface. But unlike a legitimate
 * registered-`false`, the unwired read is a wiring bug, so it is made LOUD via the
 * `managed-key-availability-unwired` marker (F4) rather than silently absorbed.
 */
export function getManagedKeyAvailability(): boolean {
  if (_managedKeyAvailabilityProvider === null) {
    log.error(
      { marker: 'managed-key-availability-unwired' },
      'Managed-key availability read before any surface wired it — forgotten bootstrap ' +
        '(registerManagedKeyAvailability). Defaulting to false (managed-key routing silently off). ' +
        'This is a wiring bug, not a legitimate "no managed key" state.',
    );
    return false;
  }
  return _managedKeyAvailabilityProvider() ?? false;
}
