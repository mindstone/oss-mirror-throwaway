// Lint regression fixture for the providerFeatureGate rule.
// Deliberate violation: Set membership keyed on `<obj>.providerType`. The
// `Set.has(<MemberExpression .providerType>)` selector should fire here.
// (Opus MA-1; existed at behindTheScenesClient.ts:1418 in bare-identifier
// form, which is the acknowledged hole — see
// `bare_identifier_acknowledged_hole.fixture.ts`.)

const TRUSTED_PROVIDERS = new Set(['openai', 'together']);

interface Profile {
  providerType: string;
}

export function isTrusted(profile: Profile): boolean {
  return TRUSTED_PROVIDERS.has(profile.providerType);
}
