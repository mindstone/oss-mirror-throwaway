/**
 * Unit tests for the tagged-object `ApplicabilityTag` and its
 * constructor / predicate helpers. Tests cover:
 *
 *   - Round-trip: the rationale survives `applicabilityTag(...)` →
 *     `getApplicabilityRationale(...)` unchanged.
 *   - Empty / whitespace-only rationale rejection (TypeError).
 *   - `isApplicabilityTag` predicate behaviour, including the
 *     load-bearing **runtime distinction** between an applicability
 *     tag and a plain axis-enum string (regression canary for the
 *     Round 2 MUST-FIX from gemini3.1-pro: branded-string predicate
 *     could not distinguish `'transient-retry'` from a real tag).
 *   - Type-level: a plain string cannot be passed where
 *     `ApplicabilityTag` is expected (negative `@ts-expect-error`).
 *
 * @see ../applicabilityTag.ts
 */

import { describe, it, expect } from 'vitest';

import {
  applicabilityTag,
  getApplicabilityRationale,
  isApplicabilityTag,
  type ApplicabilityTag,
} from '../applicabilityTag';

describe('applicabilityTag()', () => {
  it('round-trips the rationale string', () => {
    const tag = applicabilityTag(
      'not-applicable',
      'errorClassPolicy is only meaningful for `error` and `result` variants',
    );
    expect(getApplicabilityRationale(tag)).toBe(
      'errorClassPolicy is only meaningful for `error` and `result` variants',
    );
  });

  it('produces a frozen object', () => {
    const tag = applicabilityTag('not-applicable', 'fixture');
    expect(Object.isFrozen(tag)).toBe(true);
    expect(() => {
      (tag as unknown as { rationale: string }).rationale = 'mutated';
    }).toThrow();
  });

  it('throws TypeError for empty rationale', () => {
    expect(() => applicabilityTag('not-applicable', '')).toThrow(TypeError);
  });

  it('throws TypeError for whitespace-only rationale', () => {
    expect(() => applicabilityTag('not-applicable', '   \t\n  ')).toThrow(
      TypeError,
    );
  });

  it('throws TypeError for non-string rationale', () => {
    expect(() =>
      applicabilityTag('not-applicable', 42 as unknown as string),
    ).toThrow(TypeError);
  });
});

describe('isApplicabilityTag() — runtime distinction', () => {
  it('returns true for a value produced by applicabilityTag()', () => {
    const tag = applicabilityTag('not-applicable', 'rationale');
    expect(isApplicabilityTag(tag)).toBe(true);
  });

  it('returns false for plain axis-enum strings (Round 2 MUST-FIX canary)', () => {
    // Round 2 review (2026-04-29) found the v1 branded-string design
    // returned `true` for any non-empty string — including legitimate
    // axis values like `'transient-retry'`, `'permanent-fail'`,
    // `'rate-limit'`. The tagged-object design eliminates that
    // ambiguity. These assertions are the regression canary.
    expect(isApplicabilityTag('transient-retry')).toBe(false);
    expect(isApplicabilityTag('permanent-fail')).toBe(false);
    expect(isApplicabilityTag('rate-limit')).toBe(false);
    expect(isApplicabilityTag('billing-fail')).toBe(false);
  });

  it('returns false for the empty string', () => {
    expect(isApplicabilityTag('')).toBe(false);
  });

  it('returns false for non-object values', () => {
    expect(isApplicabilityTag(undefined)).toBe(false);
    expect(isApplicabilityTag(null)).toBe(false);
    expect(isApplicabilityTag(42)).toBe(false);
    expect(isApplicabilityTag('a string')).toBe(false);
  });

  it('returns false for objects with the wrong kind', () => {
    expect(
      isApplicabilityTag({ kind: 'something-else', rationale: 'x' }),
    ).toBe(false);
  });

  it('returns false for objects with empty rationale', () => {
    expect(
      isApplicabilityTag({ kind: 'not-applicable', rationale: '' }),
    ).toBe(false);
    expect(
      isApplicabilityTag({ kind: 'not-applicable', rationale: '   ' }),
    ).toBe(false);
  });

  it('returns false for objects without a rationale field', () => {
    expect(isApplicabilityTag({ kind: 'not-applicable' })).toBe(false);
  });

  it('round-trips through JSON serialisation', () => {
    // Cross-surface consumers that deserialise from JSON must still
    // recognise the tag. Construct, stringify, parse, predicate.
    const tag = applicabilityTag('not-applicable', 'cross-surface fixture');
    const json = JSON.stringify(tag);
    const parsed: unknown = JSON.parse(json);
    expect(isApplicabilityTag(parsed)).toBe(true);
  });
});

describe('ApplicabilityTag — type-level', () => {
  it('rejects assigning a plain string where ApplicabilityTag is expected', () => {
    function consume(_tag: ApplicabilityTag): void {
      /* noop */
    }

    // @ts-expect-error A plain string lacks the tagged-object shape.
    consume('not a tag');

    consume(applicabilityTag('not-applicable', 'fixture'));
    expect(true).toBe(true);
  });
});
