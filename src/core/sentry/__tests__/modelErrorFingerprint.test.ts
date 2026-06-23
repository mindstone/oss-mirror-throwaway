import { describe, expect, it } from 'vitest';
import { KNOWN_CONDITIONS } from '@core/sentry/knownConditions';
import { MODEL_ERROR_KINDS, type ModelErrorKind } from '@core/rebelCore/modelErrors';

/**
 * Rec A5 (cluster sentry-fingerprint-stability, fingerprint 372044c136762452):
 * "Per-kind fingerprint stability test for every ModelErrorKind."
 *
 * Every wrapped LLM provider failure is captured through
 * `captureKnownCondition('model_error', { kind, provider, upstreamProvider })`
 * (turnErrorRecovery.ts). The `model_error` known-condition fingerprint
 * resolver folds `ctx.kind` into the Sentry fingerprint so distinct error kinds
 * dedupe into distinct Sentry issues. The risk class this test kills: a new
 * `ModelErrorKind` ships and either (a) collapses into a neighbouring issue
 * because the resolver stopped distinguishing by kind, or (b) is simply never
 * exercised, so a fingerprint regression for that kind goes unnoticed until it
 * floods (or silently merges in) production Sentry.
 *
 * `ModelErrorKind` is derived from `MODEL_ERROR_KINDS` (a const tuple), so the
 * exhaustiveness guard below iterates the same source the union is built from:
 * a new kind cannot be added without this test seeing it.
 */
describe('model_error Sentry fingerprint stability', () => {
  const meta = KNOWN_CONDITIONS.model_error;
  const resolver = meta.fingerprint;

  it('the model_error condition exists with a dynamic resolver and a non-info level', () => {
    expect(meta).toBeDefined();
    expect(typeof resolver).toBe('function');
    // warning/error levels reach the Sentry issue stream; info would be
    // ledger-only and never produce a dedupe-able issue.
    expect(meta.level).toBe('warning');
  });

  // Resolver is a function for model_error; this guards against the entry being
  // changed to a static fingerprint (which would lose per-kind distinction).
  const resolve = (kind: ModelErrorKind, provider?: string, upstreamProvider?: string) => {
    if (typeof resolver !== 'function') {
      throw new Error('model_error fingerprint must remain a dynamic resolver to distinguish by kind');
    }
    return resolver({ kind, provider, upstreamProvider });
  };

  it.each(MODEL_ERROR_KINDS)(
    'produces a stable, kind-distinguished fingerprint for kind=%s',
    (kind) => {
      const fp = resolve(kind);

      // (1) stable readonly string array
      expect(Array.isArray(fp)).toBe(true);
      expect(fp.every((seg) => typeof seg === 'string')).toBe(true);

      // (2) the kind appears as a distinct segment, so kinds don't collapse
      expect(fp).toContain(kind);

      // (3) anchored to the model-error family so it can't collide with
      // unrelated conditions
      expect(fp[0]).toBe('model-error');

      // (4) deterministic: same input → same fingerprint (no Date.now / random)
      expect(resolve(kind)).toEqual(fp);
    },
  );

  it('distinguishes every kind from every other kind (no two kinds share a fingerprint)', () => {
    const seen = new Map<string, ModelErrorKind>();
    for (const kind of MODEL_ERROR_KINDS) {
      const key = JSON.stringify(resolve(kind));
      const prior = seen.get(key);
      expect(prior, `kind '${kind}' collides with '${prior}' on fingerprint ${key}`).toBeUndefined();
      seen.set(key, kind);
    }
    expect(seen.size).toBe(MODEL_ERROR_KINDS.length);
  });

  it('folds provider / upstreamProvider into the fingerprint without dropping kind', () => {
    const withProvider = resolve('rate_limit', 'anthropic', 'openrouter');
    expect(withProvider).toContain('rate_limit');
    expect(withProvider).toContain('anthropic');
    expect(withProvider).toContain('openrouter');

    // Absent provider/upstream still resolve to stable sentinels (no undefined
    // segments, which would JSON-serialise to null and fragment dedupe).
    const withoutProvider = resolve('rate_limit');
    expect(withoutProvider.every((seg) => typeof seg === 'string')).toBe(true);
  });

  it('exhaustiveness guard: MODEL_ERROR_KINDS covers the literal ModelErrorKind union', () => {
    // If a kind is added to the union but not to MODEL_ERROR_KINDS, this
    // assignment fails to type-check (the union is derived from the tuple, so
    // they cannot drift); this runtime list mirrors the union so a reviewer
    // editing the union literal sees a red test if they forget the tuple.
    const expectedKinds: ReadonlyArray<ModelErrorKind> = [
      'rate_limit',
      'auth',
      'billing',
      'moderation',
      'server_error',
      'network',
      'invalid_request',
      'context_overflow',
      'model_unavailable',
      'image_input_unsupported',
      'managed_model_not_allowed',
      'tool_input_too_large',
      'abort',
      'unknown',
    ];
    expect([...MODEL_ERROR_KINDS].sort()).toEqual([...expectedKinds].sort());
  });
});
