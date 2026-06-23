// Lint regression fixture for the providerFeatureGate rule.
// Deliberate violation: switch on `<obj>.kind`. The
// `SwitchStatement[discriminant.property.name='kind']` selector should fire.

interface Target {
  kind: 'anthropic-direct' | 'anthropic-proxy' | 'openai-compatible' | 'default-routing';
}

export function describe(target: Target): string {
  switch (target.kind) {
    case 'anthropic-direct':
      return 'direct';
    case 'anthropic-proxy':
      return 'proxy';
    case 'openai-compatible':
      return 'compat';
    case 'default-routing':
      return 'default';
  }
}
