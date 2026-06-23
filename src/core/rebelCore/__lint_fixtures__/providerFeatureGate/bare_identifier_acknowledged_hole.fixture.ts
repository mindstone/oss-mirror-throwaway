// Lint regression fixture for the providerFeatureGate rule — NEGATIVE case.
// Documents the acknowledged hole: bare-identifier shapes
// (`if (providerType === 'X')` where `providerType` is a function parameter,
// not member-access) are NOT caught by the lint rule because the selectors
// key on `MemberExpression`. Today's only known site was at
// `toOpenAIResponseFormat` (closure-form), which has been migrated to a
// private method on `OpenAIClient` — `this.providerType` is now caught.
// Future agents' instinct is `this.providerType`/`obj.providerType` when
// adding methods, so this hole is acceptable. The runner asserts NO error
// fires here.

export function checkProvider(providerType: string): boolean {
  return providerType === 'openai';
}
