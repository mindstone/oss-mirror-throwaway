// Lint regression fixture for the providerFeatureGate rule.
// Deliberate violation: `<obj>.providerType === '<literal>'` form. The
// equality selector at the top of `eslint.config.mjs` should fire here.

class Stub {
  private readonly providerType: string = 'openai';

  emitsStrict(): boolean {
    return this.providerType === 'openai';
  }
}

export const _stub = new Stub();
