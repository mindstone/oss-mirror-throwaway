// Lint regression fixture for the providerFeatureGate rule.
// Deliberate violation: Set membership keyed on a BARE-IDENTIFIER
// `providerType` (function parameter, not member access). The widened
// `Set.has(<Identifier providerType>)` selector should fire.
//
// This shape was the real production hole at
// `src/core/services/behindTheScenesClient.ts:1426`
// (`TRUSTED_BTS_FALLBACK_PROVIDERS.has(providerType)`), which is a curated
// routing allowlist (legitimate, has an `eslint-disable` annotation in prod).
// This fixture is the abstract version: any new bare-identifier `.has()` call
// that is NOT a routing allowlist must add a predicate or be explicitly
// annotated.

const TRUSTED_PROVIDERS = new Set(['openai', 'together']);

export function isTrusted(providerType: string): boolean {
  return TRUSTED_PROVIDERS.has(providerType);
}
