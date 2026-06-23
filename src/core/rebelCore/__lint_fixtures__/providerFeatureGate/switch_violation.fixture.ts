// Lint regression fixture for the providerFeatureGate rule.
// Deliberate violation: `switch (<obj>.providerType)` form. Switch
// statements don't generate `BinaryExpression`, so the dedicated
// `SwitchStatement[discriminant.property.name='providerType']` selector
// must fire here. (Opus MA-1.)

class Stub {
  private readonly providerType: 'openai' | 'together' | 'cerebras' | 'other' = 'openai';

  describe(): string {
    switch (this.providerType) {
      case 'openai':
        return 'native';
      case 'together':
        return 'compat';
      case 'cerebras':
        return 'compat';
      case 'other':
        return 'unknown';
    }
  }
}

export const _stub = new Stub();
