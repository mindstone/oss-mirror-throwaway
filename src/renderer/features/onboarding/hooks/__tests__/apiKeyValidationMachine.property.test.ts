/**
 * Property / fuzz spike for the pure API-key-validation logic module
 * (`apiKeyValidationMachine.ts`).
 *
 * Goal: raise confidence — BY CONSTRUCTION rather than a hand-picked matrix —
 * that the skip flag can never drift from the validation status and that the
 * boundary fold can never crash or produce an out-of-vocabulary status, over
 * thousands of deterministic random sequences of constructor applications and
 * folds from hostile `unknown` inputs.
 *
 * Properties asserted:
 *
 *  1. SAFETY — `summariseValidation` over any pair of hostile settled results
 *     never throws and always yields a representable summary; every constructor
 *     yields a representable `ApiKeyValidation` whose `statusOf` is one of the 4
 *     enum values.
 *
 *  2. ILLEGAL-STATE-UNREACHABLE — for every reachable state,
 *     `canSkipOf(s) === true ⇒ s.status === 'valid'` (skip implies valid by
 *     construction); `idle`/`validating`/`invalid` never derive canSkip true.
 *
 *  3. NON-VACUITY — a degenerate/constant fold (always reports `bothValid`)
 *     FAILS the liveness probe that the real fold passes (both `valid` and
 *     `invalid` are reached over the corpus), so the properties are not
 *     trivially true.
 *
 * Determinism: a small seeded xorshift32 PRNG (NO Math.random, NO Date.now —
 * both banned and would break determinism), seed varied by iteration index so
 * any failure reports a concrete seed to replay. Mirrors
 * `toolAuthMachine.property.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { ApiKeyValidation, ApiKeyValidationStatus } from '../apiKeyValidationTypes';
import {
  canSkipOf,
  resetValidation,
  statusOf,
  summariseValidation,
  validated,
  validating,
} from '../apiKeyValidationMachine';

const ALL_STATUSES: ApiKeyValidationStatus[] = ['idle', 'validating', 'valid', 'invalid'];

function isValidStatus(status: ApiKeyValidationStatus): boolean {
  return (ALL_STATUSES as string[]).includes(status as string);
}

// --- deterministic PRNG: xorshift32 (NO Math.random / NO Date.now) -----------

function makeRng(seed: number): () => number {
  // Force a non-zero 32-bit state; xorshift32 has a fixed point at 0.
  let state = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 0xffffffff) / 0xffffffff;
  };
}

function randInt(rng: () => number, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive) % maxExclusive;
}

/** A grab-bag of adversarial `unknown` shapes the boundary fold must survive. */
const HOSTILE_VALUES: unknown[] = [
  null,
  undefined,
  42,
  'a string',
  [],
  {},
  { ok: 'maybe' },
  { ok: true },
  { ok: false },
  { reason: 'invalid' },
  { ok: true, reason: 'unreachable' },
  { ok: true, reason: 'ok' },
  { ok: false, reason: 'invalid' },
  { ok: true, reason: 'quota_exceeded' },
  { ok: null, reason: null },
  { __proto__: { evil: true }, ok: true, reason: 'ok' },
];

function hostileSettled(rng: () => number): PromiseSettledResult<unknown> {
  // ~1-in-5 chance of a rejected leg to exercise the network_error path.
  if (rng() < 0.2) {
    return { status: 'rejected', reason: new Error('boom') };
  }
  return { status: 'fulfilled', value: HOSTILE_VALUES[randInt(rng, HOSTILE_VALUES.length)] };
}

/** Apply a random constructor, optionally folding hostile inputs first. */
function randomState(rng: () => number): ApiKeyValidation {
  const kind = randInt(rng, 4);
  switch (kind) {
    case 0:
      return resetValidation();
    case 1:
      return validating();
    case 2: {
      // Drive `validated` from a real fold of hostile inputs (the prod path).
      const summary = summariseValidation(hostileSettled(rng), hostileSettled(rng));
      return validated(rng() < 0.5, summary.bothValid);
    }
    default:
      // Direct constructor with random flags (also exercises valid-but-too-late).
      return validated(rng() < 0.5, rng() < 0.5);
  }
}

// --- Property 1 + 2: safety + illegal-state-unreachable ----------------------

describe('apiKeyValidationMachine property: safety + illegal-state-unreachable', () => {
  const ITERATIONS = 5000;

  it(`every random state has a 4-value status and canSkip⇒valid across ${ITERATIONS} samples`, () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const rng = makeRng(0x5eed_0001 + i);
      let state: ApiKeyValidation = resetValidation();

      // A short random walk of constructor applications + folds.
      for (let step = 0; step < 8; step++) {
        let next: ApiKeyValidation;
        try {
          next = randomState(rng);
        } catch (err) {
          throw new Error(`[seed=${0x5eed_0001 + i} step=${step}] constructor/fold THREW: ${(err as Error).message}`);
        }
        state = next;

        const status = statusOf(state);
        if (!isValidStatus(status)) {
          throw new Error(`[seed=${0x5eed_0001 + i} step=${step}] produced out-of-vocabulary status ${JSON.stringify(status)}`);
        }
        // canSkip ⇒ valid, by construction.
        if (canSkipOf(state) && state.status !== 'valid') {
          throw new Error(
            `[seed=${0x5eed_0001 + i} step=${step}] canSkip true while status='${state.status}' (illegal drift)`,
          );
        }
        // idle / validating / invalid never derive canSkip.
        if (state.status !== 'valid') {
          expect(canSkipOf(state)).toBe(false);
        }
      }
    }
    expect(true).toBe(true);
  });

  it('summariseValidation never throws on hostile fuzz and failureReason⇔!bothValid', () => {
    for (let i = 0; i < 3000; i++) {
      const rng = makeRng(0x11ab_0001 + i);
      const claude = hostileSettled(rng);
      const voice = hostileSettled(rng);
      let summary: ReturnType<typeof summariseValidation> | undefined;
      try {
        summary = summariseValidation(claude, voice);
      } catch (err) {
        throw new Error(`[seed=${0x11ab_0001 + i}] summariseValidation THREW: ${(err as Error).message}`);
      }
      expect(summary.bothValid).toBe(summary.claudeOk && summary.voiceOk);
      expect(summary.failureReason === null).toBe(summary.bothValid);
    }
  });
});

// --- Property 3: non-vacuity --------------------------------------------------

describe('apiKeyValidationMachine property: non-vacuity', () => {
  /**
   * A fixed corpus mixing clearly-valid leg pairs (both OK) and clearly-invalid
   * ones (so the discriminating fold MUST reach both outcomes), plus hostile
   * noise. The constructor pipeline maps each pair through the fold's `bothValid`
   * verdict, so a fold that discriminates reaches both `valid` and `invalid`,
   * while a degenerate fold that always reports `bothValid` reaches only `valid`.
   */
  const ok = (): PromiseSettledResult<unknown> => ({ status: 'fulfilled', value: { ok: true, reason: 'ok' } });
  const bad = (): PromiseSettledResult<unknown> => ({ status: 'fulfilled', value: { ok: false, reason: 'invalid' } });
  const CORPUS: Array<[PromiseSettledResult<unknown>, PromiseSettledResult<unknown>]> = [
    [ok(), ok()], // → valid
    [bad(), ok()], // → invalid
    [ok(), bad()], // → invalid
    [bad(), bad()], // → invalid
    [{ status: 'rejected', reason: new Error('x') }, ok()], // → invalid
  ];

  /**
   * Liveness probe: over the corpus, does the fold + constructor pipeline reach
   * BOTH a `valid` and an `invalid` state? The real fold must; a degenerate fold
   * that always reports `bothValid` must not.
   */
  function reachesBothValidAndInvalid(
    fold: (c: PromiseSettledResult<unknown>, v: PromiseSettledResult<unknown>) => { bothValid: boolean },
  ): { sawValid: boolean; sawInvalid: boolean } {
    let sawValid = false;
    let sawInvalid = false;
    for (const [claude, voice] of CORPUS) {
      const summary = fold(claude, voice);
      const state = validated(true, summary.bothValid);
      if (state.status === 'valid') {
        sawValid = true;
      } else {
        sawInvalid = true;
      }
    }
    return { sawValid, sawInvalid };
  }

  it('the REAL fold reaches both valid and invalid (the property has teeth)', () => {
    const { sawValid, sawInvalid } = reachesBothValidAndInvalid(summariseValidation);
    expect(sawValid).toBe(true);
    expect(sawInvalid).toBe(true);
  });

  it('a degenerate constant fold (always bothValid) FAILS the liveness probe', () => {
    const constantFold = () => ({ bothValid: true });
    const { sawValid, sawInvalid } = reachesBothValidAndInvalid(constantFold);
    expect(sawValid).toBe(true);
    // The degenerate fold can never reach `invalid` — proves the probe is not vacuous.
    expect(sawInvalid).toBe(false);
  });
});
