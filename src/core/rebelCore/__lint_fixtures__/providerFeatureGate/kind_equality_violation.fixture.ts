// Lint regression fixture for the providerFeatureGate rule.
// Deliberate violation: discriminator equality `<obj>.kind === '<literal>'`.
// The `BinaryExpression[left.property.name='kind']` selector should fire.

interface Target {
  kind: 'anthropic-direct' | 'anthropic-proxy' | 'openai-compatible' | 'default-routing';
}

export function isAnthropicDirect(target: Target): boolean {
  return target.kind === 'anthropic-direct';
}
