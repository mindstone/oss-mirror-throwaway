/**
 * Unit tests for the pure API-key-validation logic module
 * (`apiKeyValidationMachine.ts`). Covers the transition constructors +
 * selectors and the `summariseValidation` boundary fold against the invariant
 * list (I6/I7/I9/I10/I14) using hostile `unknown` inputs at the IPC seam.
 */
import { describe, expect, it } from 'vitest';
import {
  INITIAL_API_KEY_VALIDATION,
  canSkipOf,
  resetValidation,
  statusOf,
  summariseValidation,
  validated,
  validating,
} from '../apiKeyValidationMachine';

/** Helper: a fulfilled settled result wrapping a hostile `unknown` value. */
function fulfilled(value: unknown): PromiseSettledResult<unknown> {
  return { status: 'fulfilled', value };
}

/** Helper: a rejected settled result. */
function rejected(reason: unknown = new Error('timeout')): PromiseSettledResult<unknown> {
  return { status: 'rejected', reason };
}

describe('apiKeyValidationMachine — constructors + selectors', () => {
  it('INITIAL is idle and does not derive canSkip', () => {
    expect(statusOf(INITIAL_API_KEY_VALIDATION)).toBe('idle');
    expect(canSkipOf(INITIAL_API_KEY_VALIDATION)).toBe(false);
  });

  it('validating() → validating, canSkip false', () => {
    const v = validating();
    expect(statusOf(v)).toBe('validating');
    expect(canSkipOf(v)).toBe(false);
  });

  it('validated(true, true) → valid, canSkip TRUE', () => {
    const v = validated(true, true);
    expect(statusOf(v)).toBe('valid');
    expect(canSkipOf(v)).toBe(true);
  });

  it('validated(false, true) → valid, canSkip FALSE (I10 valid-but-too-late)', () => {
    // The subtle one: keys valid, but user navigated past welcome before settle.
    const v = validated(false, true);
    expect(statusOf(v)).toBe('valid');
    expect(canSkipOf(v)).toBe(false);
  });

  it('validated(_, false) → invalid, canSkip false regardless of welcome flag', () => {
    for (const onWelcome of [true, false]) {
      const v = validated(onWelcome, false);
      expect(statusOf(v)).toBe('invalid');
      expect(canSkipOf(v)).toBe(false);
    }
  });

  it('resetValidation() → idle, canSkip false', () => {
    const v = resetValidation();
    expect(statusOf(v)).toBe('idle');
    expect(canSkipOf(v)).toBe(false);
  });
});

describe('apiKeyValidationMachine — summariseValidation OK-predicate (I7)', () => {
  it('fulfilled {ok:true, reason:"ok"} on both legs → bothValid, null failureReason', () => {
    const s = summariseValidation(fulfilled({ ok: true, reason: 'ok' }), fulfilled({ ok: true, reason: 'ok' }));
    expect(s).toEqual({ claudeOk: true, voiceOk: true, bothValid: true, failureReason: null });
  });

  it('reason "unreachable" is NOT OK even with ok:true (fail-safe, I7)', () => {
    const s = summariseValidation(
      fulfilled({ ok: true, reason: 'unreachable' }),
      fulfilled({ ok: true, reason: 'ok' }),
    );
    expect(s.claudeOk).toBe(false);
    expect(s.voiceOk).toBe(true);
    expect(s.bothValid).toBe(false);
    expect(s.failureReason).toBe('claude_unreachable');
  });

  it('ok:false → not OK', () => {
    const s = summariseValidation(
      fulfilled({ ok: true, reason: 'ok' }),
      fulfilled({ ok: false, reason: 'invalid' }),
    );
    expect(s.voiceOk).toBe(false);
    expect(s.failureReason).toBe('voice_invalid');
  });

  it('rejected leg → not OK', () => {
    const s = summariseValidation(rejected(), fulfilled({ ok: true, reason: 'ok' }));
    expect(s.claudeOk).toBe(false);
    expect(s.failureReason).toBe('claude_network_error');
  });
});

describe('apiKeyValidationMachine — summariseValidation failureReason precedence (I14)', () => {
  it('both invalid → both_keys_invalid (precedence over per-leg reasons)', () => {
    const s = summariseValidation(
      fulfilled({ ok: false, reason: 'invalid' }),
      fulfilled({ ok: false, reason: 'quota_exceeded' }),
    );
    expect(s.bothValid).toBe(false);
    expect(s.failureReason).toBe('both_keys_invalid');
  });

  it('only claude invalid (fulfilled) → claude_<raw reason>', () => {
    const s = summariseValidation(
      fulfilled({ ok: false, reason: 'invalid' }),
      fulfilled({ ok: true, reason: 'ok' }),
    );
    expect(s.failureReason).toBe('claude_invalid');
  });

  it('only claude invalid (rejected) → claude_network_error', () => {
    const s = summariseValidation(rejected(), fulfilled({ ok: true, reason: 'ok' }));
    expect(s.failureReason).toBe('claude_network_error');
  });

  it('only voice invalid (fulfilled) → voice_<raw reason>', () => {
    const s = summariseValidation(
      fulfilled({ ok: true, reason: 'ok' }),
      fulfilled({ ok: false, reason: 'quota_exceeded' }),
    );
    expect(s.failureReason).toBe('voice_quota_exceeded');
  });

  it('only voice invalid (rejected) → voice_network_error', () => {
    const s = summariseValidation(fulfilled({ ok: true, reason: 'ok' }), rejected());
    expect(s.failureReason).toBe('voice_network_error');
  });

  it('fulfilled-but-missing reason on the failing leg → <leg>_unknown', () => {
    const s = summariseValidation(fulfilled({ ok: false }), fulfilled({ ok: true, reason: 'ok' }));
    expect(s.failureReason).toBe('claude_unknown');
  });

  // Locks the `?? 'unknown'` contract (matches the pre-extraction effect byte-for-byte):
  // ONLY nullish reason falls back to 'unknown'. A falsy-but-present reason (`''`, `0`,
  // `false`) is PRESERVED and stringified, NOT normalised. Guards against a future
  // "cleanup" silently changing analytics strings (cross-family GPT review, 260609).
  it('falsy-but-present reason is preserved, not normalised to unknown', () => {
    expect(summariseValidation(fulfilled({ ok: false, reason: '' }), fulfilled({ ok: true, reason: 'ok' })).failureReason).toBe('claude_');
    expect(summariseValidation(fulfilled({ ok: true, reason: 'ok' }), fulfilled({ ok: false, reason: 0 })).failureReason).toBe('voice_0');
    expect(summariseValidation(fulfilled({ ok: false, reason: false }), fulfilled({ ok: true, reason: 'ok' })).failureReason).toBe('claude_false');
  });

  // Nullish reason DOES fall back (the other side of the contract).
  it('null reason on the failing leg → <leg>_unknown (nullish fallback)', () => {
    expect(summariseValidation(fulfilled({ ok: false, reason: null }), fulfilled({ ok: true, reason: 'ok' })).failureReason).toBe('claude_unknown');
  });
});

describe('apiKeyValidationMachine — summariseValidation does NOT throw on hostile unknown', () => {
  const hostile: unknown[] = [
    null,
    undefined,
    42,
    'a string',
    [],
    {},
    { ok: 'maybe' },
    { ok: true },
    { reason: 'invalid' },
    { ok: true, reason: 'unreachable' },
    { ok: true, reason: 'ok' },
    { ok: false, reason: 'invalid' },
    { ok: null, reason: null },
    { __proto__: { evil: true }, ok: true, reason: 'ok' },
  ];

  it('survives every hostile shape on both legs without throwing, always returns a representable summary', () => {
    for (const c of hostile) {
      for (const v of hostile) {
        let s: ReturnType<typeof summariseValidation> | undefined;
        expect(() => {
          s = summariseValidation(fulfilled(c), fulfilled(v));
        }).not.toThrow();
        expect(typeof s!.claudeOk).toBe('boolean');
        expect(typeof s!.voiceOk).toBe('boolean');
        expect(s!.bothValid).toBe(s!.claudeOk && s!.voiceOk);
        // failureReason is null exactly when bothValid.
        expect(s!.failureReason === null).toBe(s!.bothValid);
      }
    }
  });

  it('null / non-object fulfilled values fold to not-OK with no throw', () => {
    const s = summariseValidation(fulfilled(null), fulfilled(undefined));
    expect(s.claudeOk).toBe(false);
    expect(s.voiceOk).toBe(false);
    expect(s.failureReason).toBe('both_keys_invalid');
  });
});
