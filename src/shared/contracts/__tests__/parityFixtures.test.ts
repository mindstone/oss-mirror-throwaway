/**
 * S2-D parity-corpus self-test. Verifies the fixture corpus itself is
 * well-formed: every variant has all 7 categories, no duplicate labels per
 * (variant, category), `expectedNormalised` only on the right categories, etc.
 */
import { describe, expect, it } from 'vitest';

import { parityFixtures } from './parityFixtures';

const VARIANTS = [
  'status',
  'assistant',
  'result',
  'tool',
  'error',
  'warning',
  'user_question',
  'user_question_answered',
  'assistant_delta',
  'thinking_delta',
  'context_overflow',
  'compaction_started',
  'compaction_summary_ready',
  'compaction_retrying',
  'compaction_completed',
  'compaction_failed',
  'recovery:started',
  'recovery:fallback_attempting',
  'recovery:fallback_succeeded',
  'recovery:compacting',
  'recovery:summary_ready',
  'recovery:retrying',
  'recovery:skeleton_attempting',
  'recovery:depth4_attempting',
  'recovery:succeeded',
  'recovery:failed',
  'recovery:last_resort_skipped',
  'turn_superseded',
  'user_message',
  'turn_started',
  'answer_phase_started',
] as const;

const CATEGORIES = [
  'positive',
  'negative',
  'legacy',
  'version-skew',
  'extra-keys',
  'unknown-variant',
  'nested-metadata',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getInputSeq(input: unknown): unknown {
  return isRecord(input) ? input.seq : undefined;
}

describe('parity fixture corpus self-test', () => {
  it('covers all 31 variants', () => {
    const coveredVariants = [...new Set(parityFixtures.map((fixture) => fixture.variant))].sort();
    expect(coveredVariants).toEqual([...VARIANTS].sort());
  });

  it('covers at least the 31 × 7 baseline fixture count', () => {
    expect(parityFixtures.length).toBeGreaterThanOrEqual(VARIANTS.length * CATEGORIES.length);
  });

  it('covers all 7 categories for each variant', () => {
    for (const variant of VARIANTS) {
      const categoriesForVariant = new Set(
        parityFixtures
          .filter((fixture) => fixture.variant === variant)
          .map((fixture) => fixture.category),
      );

      for (const category of CATEGORIES) {
        expect(
          categoriesForVariant.has(category),
          `Missing ${category} fixture for variant ${variant}`,
        ).toBe(true);
      }
    }
  });

  it('expectedNormalised present ONLY on positive + nested-metadata fixtures', () => {
    for (const fixture of parityFixtures) {
      const shouldHaveExpectedNormalised =
        fixture.category === 'positive' || fixture.category === 'nested-metadata';

      if (shouldHaveExpectedNormalised) {
        expect(
          fixture.expectedNormalised,
          `[${fixture.variant}/${fixture.category}/${fixture.label}] expectedNormalised should be defined`,
        ).toBeDefined();
      } else {
        expect(
          fixture.expectedNormalised,
          `[${fixture.variant}/${fixture.category}/${fixture.label}] expectedNormalised should be undefined`,
        ).toBeUndefined();
      }
    }
  });

  it('every fixture has a unique (variant, category, label) triple', () => {
    const seen = new Set<string>();
    for (const fixture of parityFixtures) {
      const key = `${fixture.variant}::${fixture.category}::${fixture.label}`;
      expect(seen.has(key), `Duplicate fixture triple: ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('seq parity coverage explicit on tool/assistant/result variants', () => {
    const seqCoverageVariants = ['tool', 'assistant', 'result'] as const;

    for (const variant of seqCoverageVariants) {
      const fixturesForVariant = parityFixtures.filter((fixture) => fixture.variant === variant);

      const hasPositiveSeqOne = fixturesForVariant.some(
        (fixture) =>
          fixture.category === 'positive' &&
          fixture.expectedAccept === true &&
          getInputSeq(fixture.input) === 1,
      );
      expect(hasPositiveSeqOne, `${variant} is missing positive seq:1 coverage`).toBe(true);

      const hasRejectSeqZero = fixturesForVariant.some(
        (fixture) =>
          fixture.category === 'negative' &&
          fixture.expectedAccept === false &&
          getInputSeq(fixture.input) === 0,
      );
      expect(hasRejectSeqZero, `${variant} is missing negative seq:0 coverage`).toBe(true);

      const hasRejectSeqFloat = fixturesForVariant.some(
        (fixture) =>
          fixture.category === 'negative' &&
          fixture.expectedAccept === false &&
          getInputSeq(fixture.input) === 1.5,
      );
      expect(hasRejectSeqFloat, `${variant} is missing negative seq:1.5 coverage`).toBe(true);

      const hasRejectSeqString = fixturesForVariant.some(
        (fixture) =>
          fixture.category === 'negative' &&
          fixture.expectedAccept === false &&
          getInputSeq(fixture.input) === '1',
      );
      expect(hasRejectSeqString, `${variant} is missing negative seq:'1' coverage`).toBe(true);
    }
  });

  it('every accept-fixture has parseable input (not null/undefined)', () => {
    const acceptFixtures = parityFixtures.filter((fixture) => fixture.expectedAccept);

    for (const fixture of acceptFixtures) {
      expect(
        fixture.input !== null && fixture.input !== undefined,
        `[${fixture.variant}/${fixture.category}/${fixture.label}] input should be defined`,
      ).toBe(true);
      expect(
        isRecord(fixture.input),
        `[${fixture.variant}/${fixture.category}/${fixture.label}] input should be an object`,
      ).toBe(true);
    }
  });

  it('every reject-fixture has expectedAccept: false explicit', () => {
    const rejectCategoryFixtures = parityFixtures.filter(
      (fixture) => fixture.category === 'negative' || fixture.category === 'unknown-variant',
    );

    for (const fixture of rejectCategoryFixtures) {
      expect(
        fixture.expectedAccept,
        `[${fixture.variant}/${fixture.category}/${fixture.label}] should set expectedAccept=false`,
      ).toBe(false);
    }
  });
});
