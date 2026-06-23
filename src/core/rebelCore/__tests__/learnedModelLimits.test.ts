/**
 * Tombstone tests for the deprecated `learnedModelLimits` module.
 *
 * Stage 2 of 260503_unify_learned_limits_into_profiles.md folded the dedicated
 * `rebel-core-learned-model-limits` store onto `ModelProfile` provenance
 * fields. The module is kept as a tombstone (no-op runtime) — the real
 * behavior now lives in `learnedProfileWriter.ts`. See
 * `learnedProfileWriter.test.ts` and `learnedLimitsMigration.test.ts` for
 * coverage of the new path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getLearnedContextWindow,
  recordContextOverflow,
  LEARNED_MODEL_LIMITS_STORE_VERSION,
  _resetStoreForTesting,
  _resetTombstoneWarningsForTesting,
} from '../learnedModelLimits';

const warnSpy = vi.fn();

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    warn: (...args: unknown[]) => warnSpy(...args),
    info: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

describe('learnedModelLimits (tombstone)', () => {
  beforeEach(() => {
    warnSpy.mockClear();
    _resetTombstoneWarningsForTesting();
  });

  it('getLearnedContextWindow always returns undefined', () => {
    expect(getLearnedContextWindow('claude-sonnet-4-6')).toBeUndefined();
    expect(getLearnedContextWindow('arbitrary-model')).toBeUndefined();
  });

  it('recordContextOverflow is a no-op (does not throw)', () => {
    expect(() => recordContextOverflow('any-model', 100_000)).not.toThrow();
    expect(() => recordContextOverflow('any-model', 0)).not.toThrow();
    expect(() => recordContextOverflow('any-model', -1)).not.toThrow();
  });

  it('preserves the store version registry export', () => {
    expect(LEARNED_MODEL_LIMITS_STORE_VERSION).toBe(1);
  });

  it('_resetStoreForTesting is a no-op (does not throw)', () => {
    expect(() => _resetStoreForTesting()).not.toThrow();
  });

  it('emits a tombstone warning the first time getLearnedContextWindow is called', () => {
    getLearnedContextWindow('claude-sonnet-4-6');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][1]).toContain('[tombstone]');
    getLearnedContextWindow('claude-sonnet-4-6');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('emits a tombstone warning the first time recordContextOverflow is called', () => {
    recordContextOverflow('any-model', 100_000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][1]).toContain('[tombstone]');
    recordContextOverflow('any-model', 50_000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
