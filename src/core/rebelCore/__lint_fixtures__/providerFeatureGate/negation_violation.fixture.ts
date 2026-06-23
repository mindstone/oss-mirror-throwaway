// Lint regression fixture for the providerFeatureGate rule.
// Deliberate violation: `<obj>.providerType !== '<literal>'` form. The
// negation selector should fire here. This is Bug B's actual hotfix shape.

class Stub {
  private readonly providerType: string = 'openai';

  shouldSkip(): boolean {
    return this.providerType !== 'openai';
  }
}

export const _stub = new Stub();
