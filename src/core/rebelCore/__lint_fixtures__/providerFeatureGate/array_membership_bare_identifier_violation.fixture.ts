// Lint regression fixture for the providerFeatureGate rule.
// Deliberate violation: Array membership keyed on a BARE-IDENTIFIER
// `providerType` (function parameter, not member access). The widened
// `Array.includes(<Identifier providerType>)` selector should fire.
// Symmetric to `set_membership_bare_identifier_violation.fixture.ts`.

const TRUSTED_PROVIDERS = ['openai', 'together'];

export function isTrusted(providerType: string): boolean {
  return TRUSTED_PROVIDERS.includes(providerType);
}
