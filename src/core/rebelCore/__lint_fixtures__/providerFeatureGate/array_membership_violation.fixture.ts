// Lint regression fixture for the providerFeatureGate rule.
// Deliberate violation: Array membership keyed on `<obj>.providerType`. The
// `Array.includes(<MemberExpression .providerType>)` selector should fire.

const TRUSTED_PROVIDERS = ['openai', 'together'];

interface Profile {
  providerType: string;
}

export function isTrusted(profile: Profile): boolean {
  return TRUSTED_PROVIDERS.includes(profile.providerType);
}
